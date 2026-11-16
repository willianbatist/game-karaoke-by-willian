# Arquitetura e Especificação Técnica: Jogo Web de Karaokê (`localhost`)

**Versão:** 2.2 (revisada)
**Documento complementar:** `FRONTEND_ARCHITECTURE.md` (telas, fluxo, modos de jogo, jogadores e histórico). Em conflito sobre áudio, pontuação, contratos de API, cache ou worker, este documento prevalece.
**Status:** Fonte de verdade para a fase de engenharia

> **Nota para Agentes de Desenvolvimento:** Este documento define a visão arquitetural, as decisões de design, a stack, os contratos entre componentes e as justificativas técnicas do sistema. **Não contém implementação completa**; contém apenas contratos (formatos de arquivo, rotas, eventos) e parâmetros iniciais que devem ser tratados como pontos de partida de calibração. Em caso de conflito entre este documento e uma suposição própria, **este documento prevalece**; se houver um erro técnico aqui, sinalize antes de contornar.

---

## 0. Resumo das Mudanças em Relação à v1

| # | Mudança | Motivo |
| :-- | :--- | :--- |
| 1 | O relógio mestre passa a ser o `AudioContext` do áudio local; o vídeo do YouTube vira elemento **opcional e escravo** | O `getCurrentTime()` do IFrame é impreciso, sofre com buffering e anúncios |
| 2 | Filtro do microfone passa de 200–3500 Hz para **~80–1200 Hz** e o processamento nativo do navegador (AEC/NS/AGC) é desligado | 200 Hz cortava vozes masculinas; AEC/NS/AGC distorcem o pitch |
| 3 | Extração de gabarito deixa de usar Basic Pitch (transcritor polifônico) e passa a usar **extrator de F0 monofônico** (pYIN como padrão) | O formato de saída é um contorno de F0, não notas discretas |
| 4 | Arquitetura **poliglota formalizada**: Node.js orquestra, Python executa o trabalho de IA, com contrato versionado | O separador vocal é Python; é preciso um contrato claro |
| 5 | Nova seção de **microfone amador**: calibração, ganho de software, histerese, suavização, tolerâncias por dificuldade | Hardware de baixa qualidade é a realidade, não a exceção |
| 6 | Nova seção de **dispositivos de áudio** (seleção de entrada e saída, persistência, hot-plug) | Requisito do produto |
| 7 | Nova seção de **Compatibilidade da Música** (pré-análise e pós-análise, exibida após a escolha) | Requisito do produto |
| 8 | Busca via `yt-dlp` (`ytsearch`), remoção do `yt-search` | Menos dependências frágeis |
| 9 | Cache em FLAC, `manifest.json` por música, fila com concorrência 1, progresso via SSE | Disco, previsibilidade e UX |
| 10 | Offset de letra e offset de latência persistidos por música | Letras e hardware nunca alinham perfeitamente |
| 11 | Seção de segurança local, instalação (`doctor`) e testes de aceitação | Evitar falhas de ambiente e injeção de comandos |
| 12 | Requisitos Python **separados por acelerador** (um `venv` por perfil: cpu, cuda, directml, rocm, mps) | Pacotes de aceleração conflitam no mesmo ambiente (12.2) |
| 13 | `pitchy` servido como **módulo ES local em `frontend/vendor/`** (bundle único gerado uma vez) | `AudioWorkletGlobalScope` e o navegador não resolvem *bare imports* (12.2) |
| 14 | Detecção de vazamento das caixas por **teste na calibração + heurística leve** (sem correlação cruzada com fase) | Mais barata e robusta (7.3, 7.4) |
| 15 | `AudioEngine` **consolida a posição em `offset_seek`** antes de trocar saída ou recriar roteamento | Evita a música voltar ao início (8.2) |
| 16 | Persistência de **jogadores e histórico** no backend (`backend/data/`), com novas rotas e serviços; documento de frontend separado | Requisito de histórico em arquivo local (ver `FRONTEND_ARCHITECTURE.md` seção 4) |

---

## 1. Visão Geral e Descrição do Projeto

Aplicação web de karaokê que roda em `localhost`, usa o catálogo do YouTube como fonte de músicas e IA local para transformar **qualquer música original** em faixa de karaokê jogável, com letra sincronizada e avaliação vocal de `0.0` a `10.0`.

### O Problema Resolvido
1. **Repertório limitado:** karaokês tradicionais dependem de catálogos fechados ou de arquivos feitos pela comunidade (ex.: UltraStar), com pouca cobertura de música brasileira.
2. **Qualidade e sincronia de vídeos "karaokê" amadores:** introduções alteradas quebram a sincronia de letras externas, e não há voz de referência para avaliar a afinação.

### A Solução Proposta
O usuário pesquisa a **música original**. O sistema local baixa o áudio, separa voz e instrumental por IA, extrai o contorno de afinação da voz original como gabarito e sincroniza tudo com letras de uma base aberta. O áudio baixado é a base de tempo de todo o sistema; o vídeo do YouTube é apenas um complemento visual.

---

## 2. Objetivos e Requisitos

### 2.1 Objetivos Principais
* **Catálogo ilimitado** via YouTube, com foco em repertório nacional.
* **Custo zero com APIs:** somente open-source, APIs nativas do navegador e APIs públicas gratuitas.
* **Karaokê sob demanda:** separação vocal local (GPU quando disponível, CPU como fallback).
* **Pontuação justa e divertida (`0.0`–`10.0`)**, tolerante a microfones simples e a diferenças de extensão vocal.
* **Cache inteligente:** processar uma vez, reutilizar sempre.
* **Transparência de compatibilidade:** informar ao usuário, depois que ele escolhe a música, o quanto aquela faixa tende a funcionar bem no sistema.
* **Configuração de áudio:** o usuário escolhe dispositivo de entrada (microfone) e de saída (caixas/fones).

### 2.2 Requisitos Não-Funcionais
* **Execução local:** backend e workers em `localhost`.
* **Baixa latência na captação:** análise do microfone 100% no cliente; nenhum áudio do microfone trafega pela rede.
* **Resiliência:** funcionar sem letra sincronizada, com vídeo já instrumental, com vídeo indisponível para embed e com microfone ruim (degradando de forma controlada, nunca travando).
* **Cross-platform:** Windows, macOS e Linux.
* **Browser alvo principal:** navegadores baseados em Chromium (Chrome, Edge). Firefox e Safari são suportados com limitações documentadas (ver 8.3).
* **Isolamento:** trabalho pesado nunca roda no Event Loop do Node.js.

### 2.3 Fora de Escopo (v1)
Multiusuário em rede, contas, pontuação online, distribuição pública como serviço, pontuação por palavra/sílaba, duetos.

---

## 3. Stack Tecnológica e Justificativas

| Camada | Tecnologia | Linguagem | Justificativa |
| :--- | :--- | :--- | :--- |
| **Frontend** | HTML5, CSS3, JavaScript ES Modules (Vanilla ou React) | JS | Controle direto de Web Audio, animação de letra e dispositivos de áudio |
| **Backend (orquestrador)** | Node.js 20+ com Fastify ou Express | JS | API REST, fila de jobs, supervisão de processos, SSE de progresso |
| **Worker de IA** | Python 3.10–3.12 em `venv` isolado | Python | Ecossistema de áudio/IA (separação, F0) é Python |
| **Busca e download** | `yt-dlp` (CLI) + `ffmpeg` | binários | Busca (`ytsearch`), metadados e extração do stream de áudio com a mesma ferramenta |
| **Player de vídeo (opcional)** | YouTube IFrame Player API | JS | Complemento visual mudo; não é referência de tempo |
| **Letras sincronizadas** | LRCLIB (`lrclib.net`) | HTTP | API aberta, sem chave, formato `.lrc` |
| **Separação vocal** | `audio-separator` (modelos Roformer/Demucs, com preferência por modelo "karaokê" que separa voz principal de backing vocals) | Python | Qualidade superior ao cancelamento de fase |
| **Gabarito de afinação** | **pYIN** (`librosa.pyin`) como padrão; **CREPE/torchcrepe** como alternativa configurável | Python | Extração de F0 monofônico sobre `vocals` isolado |
| **Análise do microfone** | Web Audio API (`AudioWorklet`) + `pitchy` (McLeod Pitch Method) | JS | Detecção de pitch em tempo real no cliente; biblioteca servida localmente em `frontend/vendor/` (ver 12.2) |
| **Persistência local** | Sistema de arquivos (cache) + `manifest.json` por música; preferências no `localStorage` | — | Sem banco de dados na v1 |

> **Decisão sobre linguagem:** JavaScript em tudo que for aplicação (frontend, backend, scripts de orquestração). Python existe **somente** dentro de `worker/`, como executor de tarefas de IA, atrás de um contrato (seção 5). Nenhum outro componente deve importar ou depender de código Python.

---

## 4. Princípios Arquiteturais

1. **Áudio local é a fonte da verdade do tempo.** Vídeo, letra, voz guia e pontuação são todos derivados de `AudioContext.currentTime`.
2. **Contratos antes de código.** Node e Python conversam apenas por contrato versionado (CLI + JSON Lines + arquivos em disco). Cada lado pode ser substituído sem alterar o outro.
3. **Etapas idempotentes e retomáveis.** Cada etapa do pipeline grava seu resultado e marca o `manifest.json`; uma falha na etapa 3 não refaz a 1 e a 2.
4. **Degradar, nunca quebrar.** Toda dependência opcional (vídeo, letra, voz guia, gabarito confiável) tem fallback definido.
5. **Nenhuma suposição sobre o hardware do usuário.** Microfone, caixas e GPU são variáveis; o sistema mede e se adapta (calibração, detecção de GPU, `doctor`).
6. **Honestidade com o usuário.** Se a música tem baixa compatibilidade, o sistema informa isso em vez de entregar uma nota enganosa.

---

## 5. Arquitetura do Sistema (Multi-linguagem)

### 5.1 Visão de Componentes

```text
+----------------------------------------------------------------------------------------+
|                                  FRONTEND (Browser, JS)                                |
|                                                                                        |
| [Busca] [Configurações de Áudio] [Tela de Preparo] [Tela de Jogo] [Resultado]          |
|                                                                                        |
|  AudioEngine (AudioContext = RELÓGIO MESTRE)                                           |
|   ├─ instrumental ──┐                                                                  |
|   ├─ voz guia (GainNode 0–100%) ──> destino de saída (dispositivo escolhido)           |
|   └─ microfone (dispositivo escolhido) -> filtros -> AudioWorklet -> pitchy -> Scoring |
|                                                                                        |
|  LyricSync (lê relógio mestre)    YouTubePlayer (mudo, escravo, opcional)              |
+------------------------------------------|---------------------------------------------+
                                           | HTTP REST + SSE (somente 127.0.0.1)
+------------------------------------------v---------------------------------------------+
|                            BACKEND ORQUESTRADOR (Node.js)                              |
|                                                                                        |
|  routes: /search  /songs/:id  /prepare  /jobs  /library  /health                       |
|  JobQueue (concorrência = 1)  ·  CacheManager  ·  LyricsService  ·  CompatibilityService|
|  ProcessSupervisor (spawn com array de args, timeout, cancelamento, parse JSON Lines)  |
+------------------------------------------|---------------------------------------------+
                                           | spawn (CLI) + JSON Lines (stdout) + arquivos
+------------------------------------------v---------------------------------------------+
|                           WORKER DE IA (Python, venv isolado)                          |
|                                                                                        |
|  etapa 1: download        (yt-dlp + ffmpeg)                                            |
|  etapa 2: separação       (audio-separator)                                            |
|  etapa 3: gabarito F0     (pYIN / CREPE)                                               |
|  etapa 4: análise         (métricas de compatibilidade)                                |
|  etapa 5: empacotamento   (FLAC + pitch_map.json + manifest.json, limpeza de temporários)|
+----------------------------------------------------------------------------------------+
```

### 5.2 Por que a divisão é assim
* O **Node** é bom em I/O assíncrono, filas, HTTP e supervisão de processos, mas não tem ecossistema maduro de separação de fontes.
* O **Python** executa os modelos, mas não deve conter regra de negócio, HTTP público nem estado de fila.
* O **navegador** mantém a captura do microfone e a pontuação, porque latência de rede seria inaceitável e privacidade é preservada.

### 5.3 Contrato Node ⇄ Python (versão 1)

**Modelo de execução (v1): um processo por job.** O Node executa `python -m karaoke_worker run --job <caminho_job.json>`. Vantagens: isolamento total, liberação de memória/VRAM ao fim, cancelamento simples (`SIGTERM`/`taskkill`), zero servidor adicional. Custo: carregar o modelo a cada job (alguns segundos), irrelevante diante do tempo de separação. **Evolução possível (v2):** worker residente com HTTP local, sem alterar o contrato lógico abaixo.

**Arquivo de entrada `job.json`:**
```json
{
  "contract_version": 1,
  "video_id": "abc123XYZ_0",
  "workdir": "/caminho/cache/abc123XYZ_0",
  "steps": ["download", "separate", "pitch", "analyze", "package"],
  "options": {
    "separation_model": "<definido em config>",
    "device": "auto",
    "pitch_extractor": "pyin",
    "pitch_hop_seconds": 0.02,
    "output_audio_format": "flac"
  }
}
```

**Saída em `stdout`, uma linha JSON por evento (JSON Lines).** `stderr` é reservado a logs livres.
```json
{"event":"progress","step":"separate","percent":42,"message":"Separando voz"}
{"event":"step_done","step":"download","artifacts":["source.m4a"],"seconds":8.2}
{"event":"warning","code":"LOW_VOCAL_ENERGY","message":"..."}
{"event":"error","code":"DOWNLOAD_FAILED","message":"...","retryable":true}
{"event":"done","manifest":"manifest.json"}
```

**Códigos de saída:** `0` sucesso · `10` erro recuperável (rede, tentar de novo) · `20` erro de dependência (ffmpeg/yt-dlp/modelo ausente) · `30` erro de dados (áudio inválido) · `130` cancelado.

**Regras do contrato:**
* O Node **nunca** interpreta texto livre; só eventos JSON Lines.
* O Python **nunca** escreve fora de `workdir`.
* Mudança incompatível no contrato exige incremento de `contract_version`, e o Node deve recusar um worker com versão diferente (checado no `doctor`).
* O comando `python -m karaoke_worker doctor --json` devolve o inventário do ambiente (ver seção 13).

### 5.4 Estratégia de Compatibilidade de Plataforma
* Todos os comandos externos são invocados com `spawn`/`execFile` com **array de argumentos**, nunca por string concatenada em shell.
* Caminhos tratados com `path.join`; sem suposição de separador.
* Detecção de aceleração: CUDA (NVIDIA), MPS (Apple Silicon), DirectML/ROCm quando disponível; senão CPU. O resultado é gravado no `manifest.json` (campo `device_used`) e mostrado na UI ("separação com GPU" / "separação em CPU, pode levar alguns minutos").
* Dependências Python fixadas e `venv` criado por script do projeto; nada instalado globalmente. **Os requisitos são separados por perfil de acelerador** (CPU, CUDA, DirectML, ROCm, MPS), e cada perfil usa seu próprio `venv`; nunca misturar aceleradores no mesmo ambiente (ver 12.2).

---

## 6. Pipelines de Dados

### 6.A Descoberta e Metadados
1. O usuário digita "música + artista".
2. O backend executa a busca via `yt-dlp` (`ytsearch<N>:termo`, saída JSON em modo *flat*), obtendo `videoId`, título, canal, duração e thumbnail.
3. Em paralelo, consulta o LRCLIB com título/artista **normalizados** (ver 6.A.1) para sinalizar disponibilidade de letra sincronizada.
4. O frontend lista os resultados. **A compatibilidade não aparece nesta tela** (ver seção 10); apenas indicadores baratos: duração e "letra sincronizada disponível".

#### 6.A.1 Normalização de títulos
Títulos de YouTube trazem ruído: `Artista - Música (Clipe Oficial) [Ao Vivo] HD`. O `LyricsService` deve:
* remover termos entre parênteses/colchetes e sufixos comuns ("official video", "clipe oficial", "ao vivo", "lyrics", "HD", "4K"), preservando uma marcação de versão (`live`, `acoustic`, `remix`) para uso na compatibilidade;
* tentar a busca por `artista + faixa` e, se falhar, por texto livre;
* escolher, entre os candidatos do LRCLIB, o de **menor diferença de duração** em relação ao vídeo, e permitir que o usuário troque o candidato manualmente.

### 6.B Preparação e Cache Sob Demanda
`POST /api/prepare` com `{ "videoId": "..." }`:
1. **Cache hit** (manifest com `status: ready` e `schema_version` compatível): resposta imediata.
2. **Cache miss:** cria um job e o enfileira (concorrência 1). O cliente acompanha por SSE.
3. Etapas do worker: `download → separate → pitch → analyze → package`. Cada etapa marca seu estado no `manifest.json`; um job interrompido retoma da última etapa concluída.
4. Ao final, os temporários são removidos.

**Estados do job:** `queued → running(step) → ready | failed | canceled`. A UI exibe: *Na fila → Baixando áudio → Separando voz → Gerando gabarito → Analisando compatibilidade → Pronto*, com percentual e, quando possível, tempo estimado (baseado em `device_used` e duração da faixa).

### 6.C Reprodução Sincronizada
1. O frontend baixa os arquivos do cache (`instrumental`, `vocals`) e os decodifica em `AudioBuffer`.
2. **O `AudioContext` é o relógio mestre.** Posição da música = `ctx.currentTime - t_início + offset_seek`. Pausar/retomar usa `ctx.suspend()/resume()`.
3. O instrumental e a voz guia (via `GainNode`, slider 0–100%) tocam a partir de `AudioBufferSourceNode`s iniciados no mesmo instante agendado.
4. **Letra** (`LyricSync`) lê o relógio mestre a cada frame de animação e aplica `offset_letra_ms` (salvo por música).
5. **Vídeo (opcional)** é um escravo mudo: o sistema compara periodicamente `player.getCurrentTime()` com o relógio mestre e, se a diferença passar de **~300 ms**, chama `seekTo`. Se o vídeo travar, mostrar anúncio ou falhar ao carregar, **o jogo continua normalmente**.
6. **Modo sem vídeo:** a tela de jogo funciona com fundo estático (thumbnail desfocada) e letra em destaque. É o fallback automático quando o embed falha ou o vídeo bloqueia incorporação.

#### 6.C.1 Anúncios do YouTube e conta Premium
Como o áudio do jogo é local, **anúncios no vídeo não afetam som, letra nem pontuação**; apenas deixam o fundo visual temporariamente com propaganda. Sobre o Premium: o benefício de "sem anúncios" é associado à sessão logada no navegador, e seu efeito em **vídeos incorporados em sites de terceiros** não é garantido, pois depende de cookies de terceiros e de decisões da plataforma que mudam com o tempo. Portanto: **o projeto não pode depender do Premium para funcionar.** Se o usuário estiver logado com Premium no mesmo navegador e a plataforma aplicar o benefício ao embed, será um bônus; o design assume o pior caso. Além disso, o sistema **não deve tentar bloquear ou contornar anúncios** do player, pois isso viola os termos da API do YouTube.

### 6.D Captura e Pontuação (`0.0`–`10.0`)
Detalhado nas seções 7 (microfone), 8 (dispositivos) e 9 (pontuação).

---

## 7. Captura do Microfone (Hardware Amador)

**Premissa:** o microfone será barato (embutido em notebook, fone de celular, headset simples ou Bluetooth). O sistema deve ser projetado para esse caso e tratar microfones bons como cenário fácil.

### 7.1 Configuração da Captura
Ao chamar `getUserMedia`, solicitar áudio com:
* `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false` (esses processamentos distorcem o pitch e apagam notas sustentadas);
* `channelCount: 1` e o `deviceId` escolhido nas configurações;
* sem forçar `sampleRate`; usar o que o dispositivo entregar e registrar no diagnóstico.

> Se o navegador/OS ignorar esses parâmetros (alguns dispositivos Bluetooth e drivers aplicam processamento por conta própria), o sistema deve detectar o fato por `track.getSettings()` e avisar na tela de configuração.

### 7.2 Cadeia de Processamento (parâmetros iniciais, a calibrar)

```text
MediaStream -> GainNode (ganho de software) -> HighPass ~80 Hz -> LowPass ~1200 Hz
            -> AudioWorklet (captura em blocos com timestamp do relógio mestre)
            -> pitchy (F0, clareza) -> pós-processamento -> Motor de Pontuação
```

* **Faixa de passagem ~80–1200 Hz:** cobre fundamentais de vozes graves (~80 Hz) até agudas (~1000 Hz+) e reduz ruído fora da faixa; o conteúdo harmônico acima disso não é necessário para o detector de F0.
* **Ganho de software:** definido na calibração (7.3) para compensar microfones de baixo nível sem recorrer ao AGC do navegador.
* **`AudioWorklet`** (com `AnalyserNode` como fallback) para ter timestamp preciso de cada bloco; evita o jitter de `setInterval`/`requestAnimationFrame`.
* **Janela de análise** de ~2048 amostras com hop de ~512 (ajustável), suficiente para fundamentais a partir de ~80 Hz.

### 7.3 Calibração do Microfone (tela de configuração)
Fluxo guiado de ~10 segundos, executado na primeira vez e sempre que o dispositivo mudar:
1. **Silêncio (2–3 s):** mede o **piso de ruído** (RMS). Define o *noise gate*.
2. **Fala/canto livre (4–5 s):** o usuário canta ou fala "lá, lá, lá"; mede nível de pico, ganho necessário e **extensão vocal aproximada** (nota mais grave e mais aguda detectadas com clareza).
3. **Resultado:** medidor de nível em tempo real, ganho sugerido, e um **veredito de qualidade do microfone**: *Bom / Aceitável / Fraco* (baseado em relação sinal-ruído e taxa de frames com clareza alta).
4. **Teste de vazamento (apenas se a saída for caixa de som):** toca ~3 s do instrumental ou ruído rosa em volume de jogo com o usuário em silêncio e mede o RMS do microfone. Se ficar bem acima do piso de ruído, recomenda fones ou redução de volume. Esta é a fonte principal do aviso de vazamento; a heurística de 7.4 apenas complementa durante o jogo.
5. Os valores são salvos por dispositivo (chave = `deviceId`/label) e aplicados automaticamente nas próximas sessões.

### 7.4 Robustez do Detector (tratamento de sinal ruim)
* **Noise gate dinâmico** baseado no piso medido (com histerese para não "piscar").
* **Limiar de clareza com histerese:** liga acima de um limiar (ex.: ~0.85) e só desliga abaixo de um limiar menor (ex.: ~0.70). Valores iniciais; calibrar com testes reais.
* **Filtro de mediana** (3–5 frames) sobre o MIDI estimado para remover saltos de oitava e picos espúrios.
* **Hold de ~100–150 ms:** quando o detector falha por um instante (consoantes, respiração), manter a última nota válida por esse curto período em vez de zerar o frame.
* **Descarte de frames implausíveis:** F0 fora da faixa humana (~65–1200 Hz) é ignorado.
* **Aviso de vazamento (heurística leve, sem correlação cruzada com alinhamento de fase):** durante o jogo, combina dois sinais: (a) o RMS do microfone permanece acima do piso de ruído por vários segundos em trechos onde `pitch_map.json` marca `midi: null` (partes sem voz); (b) o envelope de energia do microfone (resolução de ~50–100 ms) acompanha o envelope do instrumental, testando uma pequena faixa de atrasos (ex.: 0–300 ms). O aviso ("Use fones de ouvido para uma pontuação mais justa") só dispara com evidência sustentada, é suave (nunca bloqueia o jogo) e deve ser **descartado se o detector indicar canto do usuário** naquele trecho (clareza alta), pois o jogador pode estar cantarolando solos ou ao fundo. Falsos positivos também podem vir de erros de separação que deixam o gabarito sem voz onde há voz.
* **Alerta de Bluetooth:** microfones Bluetooth costumam ter taxa de amostragem baixa e latência alta; avisar e sugerir uso de fio ou do microfone do headset conectado por cabo.

### 7.5 Compensação de Latência
Latência total = saída de áudio + propagação + entrada do microfone (+ buffer do navegador).
* **Slider manual** `0–400 ms` nas configurações, salvo **por combinação (entrada, saída)**.
* **Calibração assistida (opcional):** reproduz cliques pela saída e mede o retorno no microfone (funciona com caixas; com fones de ouvido o método não funciona, e a UI deve explicar e manter o slider manual).
* O offset é aplicado deslocando o instante em que cada frame do microfone é comparado ao gabarito.

---

## 8. Dispositivos de Áudio (Entrada e Saída)

### 8.1 Requisito
Uma tela **Configurações → Áudio** permite escolher:
* **Entrada (microfone):** lista de dispositivos `audioinput`.
* **Saída (alto-falante/fone):** lista de dispositivos `audiooutput`.
* Volumes: instrumental, voz guia, retorno do microfone (*monitoring*, desligado por padrão para evitar microfonia).
* Calibração de microfone, offset de latência, nível de dificuldade (ver 9) e idioma da interface.

### 8.2 Comportamento Técnico
* **Listagem:** `navigator.mediaDevices.enumerateDevices()`. Os nomes (`label`) só aparecem depois da permissão do microfone; a tela deve pedir permissão primeiro e explicar por quê. `localhost` é contexto seguro, então a permissão funciona sem HTTPS.
* **Hot-plug:** escutar `devicechange` e atualizar as listas; se o dispositivo ativo desaparecer, pausar o jogo e pedir nova escolha, sem perder o estado.
* **Persistência:** salvar a escolha no `localStorage`. Se o `deviceId` salvo não existir mais, voltar ao padrão do sistema e avisar.
* **Seleção de saída:** usar `AudioContext` com `sinkId` / `setSinkId` quando disponível. Alternativa portátil: rotear o áudio do jogo para um `MediaStreamAudioDestinationNode` conectado a um `<audio>` e aplicar `setSinkId` nesse elemento.
* **Troca de saída preserva a posição:** antes de qualquer ação que re-ancore ou recrie o roteamento (`setSinkId`, recriação do `AudioContext`, reação a `devicechange`), o `AudioEngine` consolida a posição atual (`ctx.currentTime - t_início + offset_seek`) em `offset_seek`, para os sources, recria os `AudioBufferSourceNode`s (descartáveis: não podem ser retomados nem buscados) e os reinicia a partir de `offset_seek` com um novo `t_início`. Os `AudioBuffer`s já decodificados são reaproveitados. Mesmo quando o navegador permite `setSinkId` sem recriar o contexto, consolidar por segurança. Em seguida, reconectar o microfone e aplicar o offset de latência do novo par (entrada, saída).
* **Seleção de entrada:** `getUserMedia` com `deviceId` exato.
* **Teste de dispositivos:** botão "Testar saída" (toca um som curto) e medidor de nível de entrada ao vivo.

### 8.3 Suporte por Navegador

| Recurso | Chromium (Chrome/Edge) | Firefox | Safari |
| :--- | :--- | :--- | :--- |
| Escolha de entrada | Sim | Sim | Sim (com limitações) |
| Escolha de saída | Sim | Parcial/variável conforme versão | Limitada |
| `AudioWorklet` | Sim | Sim | Sim |

Quando a escolha de saída não for suportada, a UI **desabilita o seletor e informa o motivo**, usando a saída padrão do sistema. O projeto recomenda Chromium como navegador principal (a confirmar nos testes de aceitação, pois o suporte evolui).

### 8.4 Opção Avançada (fase posterior)
Rotear a **voz guia** apenas para o fone e o **instrumental** para as caixas, usando duas saídas distintas. Só deve ser considerada depois da v1 estável.

---

## 9. Motor de Pontuação (`0.0`–`10.0`)

### 9.1 Gabarito (`pitch_map.json`)
Contorno de F0 da voz original, gerado pelo worker sobre `vocals` isolado. Formato compacto (arrays paralelos, em vez de um objeto por frame):
```json
{
  "schema_version": 1,
  "extractor": "pyin",
  "hop": 0.02,
  "t0": 0.0,
  "midi": [null, null, 64.1, 64.0, 64.2, 65.8],
  "conf": [0.0, 0.0, 0.95, 0.97, 0.96, 0.88],
  "mode": "reference"
}
```
* `midi` é um número real (permite cents) ou `null` em trechos sem voz.
* `hop` é o passo em segundos (padrão `0.02`).
* `mode`: `"reference"` (gabarito confiável) ou `"heuristic"` (ver seção 11).

### 9.2 Qualidade do Gabarito
Voz de apoio e coros poluem a referência. Mitigações: usar modelo de separação "karaokê" (voz principal vs. backing); **só pontuar frames com `conf` alto** (limiar inicial ~0.6, calibrável); e registrar a proporção de frames confiáveis no manifest (entra na compatibilidade, seção 10).

### 9.3 Comparação Agnóstica de Oitava
Conversão de frequência para MIDI:

$$\text{MIDI} = 69 + 12 \cdot \log_2\left(\frac{f}{440}\right)$$

Distância em semitons **circular módulo 12** (compara a classe da nota, permitindo que vozes graves e agudas cantem qualquer música):

$$d = |\text{MIDI}_{usuário} - \text{MIDI}_{gabarito}| \bmod 12, \qquad \Delta = \min(d,\; 12 - d)$$

### 9.4 Tolerâncias por Dificuldade (considerando microfone amador)

| Dificuldade | 100% dos pontos | 50% dos pontos | 0 pontos |
| :--- | :--- | :--- | :--- |
| **Fácil** (padrão para mic *Fraco*) | $\Delta \le 1.0$ | $1.0 < \Delta \le 2.0$ | $\Delta > 2.0$ |
| **Normal** | $\Delta \le 0.8$ | $0.8 < \Delta \le 1.8$ | $\Delta > 1.8$ |
| **Difícil** | $\Delta \le 0.5$ | $0.5 < \Delta \le 1.2$ | $\Delta > 1.2$ |

O sistema sugere a dificuldade com base no veredito da calibração do microfone, mas o usuário pode alterá-la. Valores são pontos de partida e **devem ser calibrados com dados reais** (ver seção 14).

### 9.5 Regras de Contagem de Frames
* **Frame contado:** gabarito com voz **e** `conf` acima do limiar.
* **Frame ignorado:** gabarito sem voz (não penaliza silêncio do jogador, não bonifica).
* **Frame com gabarito e sem voz do jogador** (após *hold*): 0 ponto.
* **Compensação de latência** aplicada antes da comparação (7.5).

### 9.6 Nota Final
Ao fim da música (ou ao encerrar o jogo), a nota é a média dos pontos dos frames contados, escalada para `0.0`–`10.0`:

$$\text{Nota} = 10 \cdot \frac{\sum_{i \in \text{contados}} p_i}{\#\text{contados}}$$

Além da nota geral, o resultado deve mostrar: % de acertos por trecho (linha do tempo), melhor sequência e uma observação de confiança caso a compatibilidade da música seja baixa ("esta nota pode ser menos precisa porque o gabarito é pouco confiável").

### 9.7 Transposição Automática (opcional, desligada por padrão)
Se o jogador canta consistentemente um mesmo número de semitons acima ou abaixo do gabarito, o sistema pode estimar o desvio circular dominante nos primeiros trechos e aplicá-lo como correção. Por alterar a justiça da pontuação, deve ser uma opção explícita ("Ajuste automático de tom"), visível no resultado.

---

## 10. Compatibilidade da Música com o Sistema

### 10.1 Objetivo e Momento de Exibição
Algumas músicas funcionam muito melhor que outras (mixagem densa, coros, instrumental, ao vivo, voz muito processada). O sistema informa isso ao usuário **depois que ele escolhe a música** nos resultados da busca, não durante a busca. Isso evita análises caras para todos os resultados.

### 10.2 Duas Fases

**Fase 1: Pré-análise (instantânea, antes de processar, baseada em metadados)**
Exibida na tela de preparo logo após a escolha. Heurísticas baratas:
* título/canal indicam *karaoke*, *instrumental*, *cover*, *remix*, *ao vivo*, *acústico*, *mashup*, *loop*, *playlist*;
* duração fora do usual (muito curta ou acima de ~8 minutos, sugerindo compilação ou set);
* letra sincronizada encontrada no LRCLIB e **diferença de duração** entre a letra e o vídeo;
* gênero/estilo inferido apenas quando houver metadado confiável (opcional).

Resultado: **nível provisório** e avisos ("versão ao vivo: a letra pode estar desalinhada").

**Fase 2: Pós-análise (medida, depois da separação e do gabarito)**
Calculada pelo worker (etapa `analyze`) e gravada no `manifest.json`. Métricas:

| Métrica | O que mede | Interpretação |
| :--- | :--- | :--- |
| `voiced_ratio` | % do tempo em que o gabarito tem voz com confiança | Muito baixo: pouca melodia a pontuar |
| `mean_confidence` | confiança média do F0 nos frames com voz | Baixo: gabarito instável |
| `vocal_energy_ratio` | energia de `vocals` vs. mix original | Quase zero: faixa já é instrumental |
| `bleed_estimate` | resíduo de instrumento no stem de voz | Alto: separação suja |
| `backing_vocals_estimate` | presença de vozes simultâneas | Alto: gabarito pode seguir a voz errada |
| `pitch_stability` | variação do contorno (saltos de oitava) | Alto ruído: gabarito não confiável |
| `lyrics_sync_quality` | presença e alinhamento da letra `.lrc` | Ausente/desalinhada: rebaixa a experiência |

### 10.3 Níveis de Compatibilidade

| Nível | Significado para o usuário |
| :--- | :--- |
| **Excelente** | Gabarito confiável, letra sincronizada; pontuação precisa |
| **Boa** | Funciona bem, com pequenas imprecisões |
| **Regular** | Jogável, com avisos (ex.: coros fortes, letra sem sincronia) |
| **Baixa** | Pontuação pouco confiável; o sistema sugere outra versão da música |
| **Incompatível** | Ex.: sem voz detectável; aplica o fallback de 11.1 ou recomenda trocar de vídeo |

O nível é uma **pontuação ponderada** das métricas acima (pesos iniciais definidos em arquivo de configuração e ajustáveis por testes), sempre acompanhado de **motivos em linguagem simples** ("Muitas vozes de apoio", "Letra sem sincronização", "Versão ao vivo").

### 10.4 Onde é Exibido
* **Tela de preparo:** nível provisório (fase 1) e, ao concluir a análise, o nível final (fase 2).
* **Tela de pré-jogo:** selo de compatibilidade, motivos e ações: *Jogar assim mesmo*, *Escolher outra versão*, *Ajustar letra*.
* **Biblioteca:** selo em cada música já processada.
* **Resultado:** aviso de confiança da nota quando o nível for Regular ou menor.

### 10.5 Recomendação de Alternativa
Quando o nível for Baixo, a UI pode oferecer outros resultados da mesma busca (ex.: a versão de estúdio no lugar de uma ao vivo), sem reprocessar até o usuário escolher.

---

## 11. Tratamento de Exceções e Fallbacks

| Situação | Detecção | Comportamento |
| :--- | :--- | :--- |
| **Vídeo já é karaokê/instrumental** | `vocal_energy_ratio` próximo de zero | `pitch_map.mode = "heuristic"`; a letra externa é desativada (o vídeo traz a sua); pontuação por **estabilidade de afinação** (notas válidas sustentadas) e **presença vocal**, com aviso de menor precisão |
| **Sem letra sincronizada** | LRCLIB sem `syncedLyrics` | Exibe `plainLyrics` com rolagem manual/proporcional; pontuação melódica segue normal |
| **Sem nenhuma letra** | LRCLIB sem resultado | Jogo funciona só com a melodia; avisa o usuário |
| **Letra desalinhada** | diferença de duração ou percepção do usuário | Offset de letra ajustável em tempo real e salvo por música |
| **Vídeo bloqueia incorporação ou falha** | erro do IFrame API | Modo sem vídeo (6.C.6) |
| **Anúncio no vídeo** | — | Ignorado pelo sistema; áudio local mantém o jogo |
| **Download falha** (mudança no YouTube) | exit code do `yt-dlp` | Erro `retryable`; mensagem orientando atualizar o `yt-dlp` (ver 13) |
| **GPU indisponível** | `doctor`/worker | Fallback transparente para CPU, com estimativa de tempo maior |
| **Microfone sem permissão / sem dispositivo** | erros do `getUserMedia` | Mensagem clara e atalho para Configurações → Áudio |
| **Dispositivo removido durante o jogo** | `devicechange` | Pausa e pede nova escolha, mantendo o estado |
| **Vazamento de caixa de som no mic** | correlação entrada ↔ instrumental | Aviso para usar fones |
| **Cache corrompido** | validação de `manifest`/checksums | Marca como inválido e reprocessa a partir da etapa afetada |
| **Disco cheio** | erro de escrita | Interrompe o job, informa e oferece limpar músicas antigas |

---

## 12. Estrutura de Diretórios

```text
karaoke-local/
├── docs/
│   ├── ARCHITECTURE.md             # Este documento (backend, worker, contratos)
│   └── FRONTEND_ARCHITECTURE.md    # Frontend, UX, modos de jogo, histórico
├── config/
│   ├── default.json                # Limiares, pesos de compatibilidade, modelos, porta
│   └── compatibility-weights.json  # Pesos da pontuação de compatibilidade
├── backend/                        # Node.js (orquestrador)
│   ├── server.js
│   ├── routes/                     # search, prepare, jobs, library, songs, health; players, history
│   ├── services/
│   │   ├── searchService.js        # yt-dlp (ytsearch) + normalização de títulos
│   │   ├── lyricsService.js        # LRCLIB + escolha de candidato por duração
│   │   ├── compatibilityService.js # Pré-análise (metadados) e leitura da pós-análise
│   │   ├── jobQueue.js             # Fila, concorrência 1, estados, SSE
│   │   ├── processSupervisor.js    # spawn, timeout, cancelamento, parse JSON Lines
│   │   ├── cacheManager.js         # Leitura/validação/limpeza de manifest
│   │   ├── playerService.js        # Perfis de jogadores (backend/data/players.json)
│   │   └── historyService.js       # Histórico, rankings, exportação CSV/TXT
│   ├── data/                       # Dados do usuário: players.json, history.json, backups/
│   └── cache/                      # Persistente, por videoId
│       └── <videoId>/
│           ├── manifest.json       # Estado, versões, métricas, compatibilidade, offsets
│           ├── instrumental.flac
│           ├── vocals.flac
│           ├── pitch_map.json
│           └── lyrics.json         # Candidato escolhido (synced/plain)
├── worker/                         # Python (executor de IA), venv isolado
│   ├── requirements-base.txt       # Dependências comuns, sem torch/onnxruntime
│   ├── setup/                      # Instalação e modelos
│   │   ├── requirements-cpu.txt
│   │   ├── requirements-cuda.txt   # NVIDIA
│   │   ├── requirements-directml.txt # Windows (AMD/Intel)
│   │   ├── requirements-rocm.txt   # AMD, Linux
│   │   ├── requirements-mps.txt    # Apple Silicon
│   │   └── install.js|py           # Detecta GPU, escolhe perfil, cria o venv, baixa modelos
│   └── karaoke_worker/
│       ├── __main__.py             # CLI: run | doctor
│       ├── contract.py             # Esquema do job e dos eventos
│       ├── steps/
│       │   ├── download.py
│       │   ├── separate.py
│       │   ├── pitch.py
│       │   ├── analyze.py          # Métricas de compatibilidade
│       │   └── package.py
│       └── util/                   # Detecção de GPU, ffmpeg, I/O de eventos
├── frontend/
│   ├── index.html
│   ├── styles/
│   ├── vendor/
│   │   └── pitchy.js               # Bundle ESM único, versão registrada (ver 12.2)
│   └── src/
│       ├── app.js
│       ├── api.js                  # REST + SSE
│       ├── settings/
│       │   ├── audioDevices.js     # enumerateDevices, devicechange, persistência
│       │   └── micCalibration.js   # Calibração e perfil por dispositivo
│       ├── audio/
│       │   ├── audioEngine.js      # AudioContext (relógio mestre), playback, rotas de saída
│       │   ├── micCapture.js       # getUserMedia, filtros, ganho, AudioWorklet
│       │   ├── pitchWorklet.js     # Captura em blocos com timestamp
│       │   └── pitchDetector.js    # pitchy + pós-processamento (mediana, hold, histerese)
│       ├── game/
│       │   ├── scoringEngine.js    # Distância circular, tolerâncias, nota final
│       │   └── lyricSync.js        # Parser LRC, offset, renderização
│       ├── video/
│       │   └── youtubePlayer.js    # IFrame API, mudo, correção de deriva
│       └── ui/                     # Telas: busca, preparo, compatibilidade, jogo, resultado
├── scripts/
│   ├── doctor.js                   # Verificação de ambiente (Node + chama worker doctor)
│   └── update-ytdlp.js
└── README.md                       # Instalação passo a passo
```

### 12.1 `manifest.json` (esquema resumido)
```json
{
  "schema_version": 1,
  "video_id": "abc123XYZ_0",
  "status": "ready",
  "steps_done": ["download", "separate", "pitch", "analyze", "package"],
  "source": { "title": "...", "channel": "...", "duration": 241.3 },
  "pipeline": {
    "separation_model": "...",
    "pitch_extractor": "pyin",
    "device_used": "cuda",
    "worker_contract_version": 1
  },
  "files": { "instrumental": "instrumental.flac", "vocals": "vocals.flac", "pitch_map": "pitch_map.json" },
  "metrics": {
    "voiced_ratio": 0.0, "mean_confidence": 0.0, "vocal_energy_ratio": 0.0,
    "bleed_estimate": 0.0, "backing_vocals_estimate": 0.0, "pitch_stability": 0.0
  },
  "compatibility": { "level": "good", "score": 0.0, "reasons": ["..."] },
  "lyrics": { "source": "lrclib", "type": "synced", "offset_ms": 0 },
  "user": { "latency_offsets_ms": {}, "last_played": null }
}
```

---

### 12.2 Notas de Ambiente (Fases 0 a 2)

**A) Aceleradores e dependências Python.** Pacotes de aceleração conflitam quando instalados no mesmo `venv` (por exemplo, as variantes CPU, GPU e DirectML do `onnxruntime` ocupam o mesmo módulo, e builds de `torch` para CUDA e para CPU não coexistem). Regras:
* **Um `venv` por perfil de acelerador**: `cpu`, `cuda`, `directml`, `rocm` (somente Linux) e `mps` (Apple Silicon). Nunca instalar dois perfis no mesmo ambiente.
* `requirements-base.txt` guarda o que é comum; cada `requirements-<perfil>.txt` acrescenta apenas o necessário do perfil, com versões fixadas.
* O script de instalação detecta o hardware (ex.: presença de GPU NVIDIA, Apple Silicon, GPU no Windows), **propõe um perfil** e aceita override manual (`--accelerator cpu`). O perfil escolhido é gravado junto ao `venv`.
* O `doctor` confere se o perfil instalado corresponde ao hardware e se o acelerador realmente funciona (caso contrário, recomenda recriar o `venv` ou usar `cpu`). Trocar de perfil significa **recriar** o `venv`, não "adicionar por cima".
* As URLs de índice e versões exatas dos pacotes por perfil devem ser verificadas na implementação, pois mudam com frequência.

**B) `pitchy` no navegador sem bundler no fluxo normal.** O `AudioWorkletGlobalScope` e o navegador não resolvem importações "nuas" (`import ... from 'pitchy'`) como o Node resolve. Regras:
* A biblioteca é servida como **módulo ES estático local** em `frontend/vendor/pitchy.js`, importado por caminho relativo/URL.
* Como a `pitchy` pode depender de outra biblioteca interna (por exemplo, de FFT), copiar um único arquivo pode não bastar: gerar **uma vez** um bundle ESM único (ex.: com `esbuild`), commitar o resultado e registrar a versão de origem. Depois disso, o projeto não exige nenhum passo de build para rodar.
* **Decisão recomendada:** o `AudioWorklet` apenas **captura blocos e envia timestamp** (via `postMessage`); a detecção com `pitchy` roda na thread principal ou em um Web Worker. Isso simplifica a depuração e evita limitações do escopo do worklet. Se a detecção for movida para dentro do worklet, o import deve usar o mesmo arquivo de `vendor/`.


## 13. API Interna, Operação e Instalação

### 13.1 Rotas (REST + SSE, somente `127.0.0.1`)

| Rota | Função |
| :--- | :--- |
| `GET /api/search?q=` | Busca no YouTube + indicador de letra |
| `POST /api/prepare` | Cria/consulta job de preparo (`{ videoId }`) |
| `GET /api/jobs/:id/events` | Progresso em SSE |
| `POST /api/jobs/:id/cancel` | Cancela job |
| `GET /api/songs/:id` | Manifest (status, compatibilidade, letra) |
| `GET /api/songs/:id/files/:name` | Entrega dos arquivos do cache ao frontend |
| `PATCH /api/songs/:id` | Atualiza offsets/escolha de letra |
| `GET /api/library` | Lista de músicas processadas com selo de compatibilidade |
| `DELETE /api/songs/:id` | Remove do cache |
| `GET /api/health` | Resultado do `doctor` (dependências, GPU, versões) |
| `/api/players`, `/api/history` e `/api/history/export` | Jogadores, histórico de partidas, rankings e exportação CSV/TXT. Contratos detalhados em `FRONTEND_ARCHITECTURE.md` seção 13 |

### 13.2 Fila de Jobs
* Concorrência **1** (separação satura GPU/CPU).
* Prioridade FIFO; cancelamento por usuário; timeout configurável por etapa.
* Estado dos jobs reidratado dos `manifest.json` na inicialização do servidor.

### 13.3 `doctor` (verificação de ambiente)
Comando único (`node scripts/doctor.js`) que verifica e reporta, com instruções de correção:
* versão do Node; versão do Python e `venv` do worker; `ffmpeg`; `yt-dlp` (e versão); runtime JS exigido pelo `yt-dlp`, se aplicável;
* modelos de separação baixados;
* aceleração disponível (CUDA/MPS/CPU);
* espaço em disco; compatibilidade do `contract_version`.

### 13.4 Manutenção do `yt-dlp`
O YouTube muda com frequência e o `yt-dlp` precisa de atualizações regulares. O projeto deve fornecer `update-ytdlp`, exibir a versão em `/api/health` e orientar o usuário quando um download falhar por motivo conhecido.

### 13.5 Segurança Local
* Servidor **vinculado a `127.0.0.1`**, CORS restrito à origem do próprio frontend.
* `videoId` validado por expressão regular estrita (11 caracteres `[A-Za-z0-9_-]`) antes de qualquer uso; **nunca** interpolar entrada do usuário em shell.
* Todos os processos filhos com `spawn` + array de argumentos.
* Rota de arquivos restrita ao diretório de cache (proteção contra *path traversal*).
* O áudio do microfone **nunca** sai do navegador.

### 13.6 Disco
FLAC reduz o cache em relação a WAV (ordem de ~25–35 MB por música de 4 min, somando os dois stems; valor aproximado). Política de limpeza por LRU com limite configurável (ex.: 10 GB), com aviso ao usuário.

---

## 14. Validação e Critérios de Aceitação

### 14.1 Spike Obrigatório (antes de construir a interface)
Script manual: link → áudio → separação → `pitch_map.json`. Executar em um **conjunto de teste de ~20 músicas** cobrindo MPB, sertanejo, pagode, rock nacional, pop, com e sem coros, estúdio e ao vivo. Registrar: tempo de processamento (GPU/CPU), qualidade do stem de voz, `voiced_ratio` e `mean_confidence`. **Esse resultado define os limiares finais de compatibilidade.**

### 14.2 Testes de Pontuação
* **Teste "gabarito contra si mesmo":** tocar o próprio `vocals` como entrada simulada deve render nota ≈ 10.
* **Teste de ruído:** adicionar ruído branco e atenuação para simular microfone fraco; a nota deve degradar de forma gradual, não abrupta.
* **Teste de oitava:** a mesma melodia uma oitava acima/abaixo deve manter a nota.
* **Teste de silêncio:** ficar calado deve render nota próxima de 0.
* **Teste de latência:** deslocamento artificial deve ser corrigido pelo offset.

### 14.3 Testes de Dispositivos
Trocar microfone e saída durante a sessão; remover dispositivo durante o jogo; negar permissão; testar Chromium e Firefox; testar com microfone Bluetooth e com microfone embutido de notebook.

### 14.4 Critérios de Aceitação do MVP
1. Dada uma música do conjunto de teste, o fluxo completo (busca → preparo → jogo → nota) funciona sem intervenção manual.
2. O progresso é exibido em todas as etapas; o cancelamento funciona.
3. Segunda execução da mesma música carrega do cache em poucos segundos.
4. Letra aparece sincronizada com offset ajustável; sem letra, o jogo continua.
5. Usuário consegue escolher microfone e saída e a escolha persiste.
6. Selo de compatibilidade aparece após a escolha da música, com motivos.
7. Falha do vídeo do YouTube não interrompe o jogo.

---

## 15. Riscos e Considerações Legais

| Risco | Mitigação |
| :--- | :--- |
| `yt-dlp` quebra por mudanças do YouTube | Script de atualização, `doctor`, mensagens claras |
| Instalação complexa (Python, modelos de centenas de MB) | `README` passo a passo, scripts de `setup`, `doctor` |
| Separação lenta em CPU | Fila, estimativa de tempo, cache, aviso de GPU |
| Pontuação injusta com microfone ruim | Calibração, dificuldade Fácil, tolerâncias, aviso de confiança |
| Gabarito contaminado por coros | Modelo "karaokê", filtro por confiança, nível de compatibilidade |
| Letra de outra versão | Escolha por duração, troca manual, offset salvo |
| **Termos de uso / direitos autorais** | Baixar áudio do YouTube viola os termos da plataforma e separar obras protegidas é zona cinzenta. O projeto destina-se a **uso pessoal em `localhost`** e **não deve ser distribuído como serviço público**. Documentar isso no `README`. |

---

## 16. Roadmap de Implementação

1. **Fase 0 (Spike do worker):** contrato Node ⇄ Python, `doctor`, pipeline em linha de comando, geração de `manifest.json` e métricas. Validar com o conjunto de teste (14.1).
2. **Fase 1 (Player):** `AudioEngine` com relógio mestre, instrumental + voz guia, letra LRC com offset, vídeo opcional mudo.
3. **Fase 2 (Dispositivos e microfone):** tela de configurações de áudio, calibração, cadeia de captura, `pitchy`.
4. **Fase 3 (Pontuação):** `scoringEngine`, dificuldades, latência, tela de resultado; calibração com dados reais.
5. **Fase 4 (Produto):** busca, fila, SSE, biblioteca, compatibilidade (fases 1 e 2), polimento e fallbacks.

---

## 17. Diretrizes Finais para Agentes de Código

1. **Não introduzir APIs pagas** nem serviços de nuvem com faturamento.
2. **Manter o trabalho pesado isolado** no worker; nunca bloquear o Event Loop do Node.js.
3. **Respeitar o contrato Node ⇄ Python** (seção 5.3); não acoplar os lados por outro meio.
4. **O `AudioContext` é o relógio mestre** (seção 6.C); não usar o tempo do YouTube como referência.
5. **Desligar AEC/NS/AGC** na captura do microfone (seção 7.1).
6. **Garantir compatibilidade cross-platform** dos comandos externos, com GPU quando houver e fallback para CPU.
7. **Tratar todos os limiares deste documento como valores iniciais** e expô-los em `config/`, nunca como constantes espalhadas no código.
8. **Priorizar a UX de espera** (progresso claro por etapa) e **a transparência de compatibilidade** (seção 10).
9. **Validar entradas** e nunca interpolar dados do usuário em comandos de shell (seção 13.5).

10. **Separar requisitos Python por acelerador**, um `venv` por perfil, nunca misturar (seção 12.2).
11. **Servir `pitchy` como módulo local em `frontend/vendor/`**; não depender de resolução de módulos do Node no navegador (seção 12.2).
12. **Detectar vazamento por teste de calibração e heurística leve**, sem correlação cruzada com fase (seções 7.3 e 7.4).
13. **Preservar a posição da música em qualquer troca de dispositivo ou roteamento** consolidando em `offset_seek` (seção 8.2).