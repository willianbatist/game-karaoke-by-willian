# Arquitetura do Frontend: Jogo Web de Karaokê (`localhost`)

**Versão:** 1.0
**Documento pai:** `ARCHITECTURE.md` (v2.2)
**Status:** Fonte de verdade para telas, fluxo, estado, modos de jogo e histórico do jogador

> **Nota para Agentes de Desenvolvimento:** Este documento detalha a camada de frontend. **Não repete** as regras técnicas já definidas em `ARCHITECTURE.md`; ele as referencia por seção (ver seção 12). Em caso de conflito sobre áudio, pontuação, contratos de API, cache ou worker, **o `ARCHITECTURE.md` prevalece**. Este documento prevalece em tudo que for interface, navegação, estado da aplicação, modos de jogo e dados de jogador/histórico. Contém contratos e decisões, não implementação completa.

---

## 1. Escopo e Princípios

### 1.1 O que este documento cobre
Telas e fluxo de navegação, modos de jogo, perfil de jogador e histórico de partidas, decisão sobre o vídeo, organização de módulos e estado, preferências do usuário, estados de erro da interface e critérios de aceitação do frontend.

### 1.2 O que não cobre
Pipeline de IA, worker Python, fila de jobs, cache de áudio, motor de pontuação e cadeia de captura do microfone. Tudo isso está no `ARCHITECTURE.md`.

### 1.3 Princípios
1. **Jogo primeiro, configuração depois.** O caminho "abrir → cantar" deve ter o mínimo de passos; ajustes finos ficam acessíveis, não obrigatórios.
2. **O áudio manda.** A interface lê o relógio mestre do `AudioEngine` e nunca o contrário (`ARCHITECTURE.md` 6.C).
3. **A interface nunca trava por dependência opcional.** Vídeo, letra e voz guia podem falhar sem derrubar a partida.
4. **Dados do usuário são locais e transparentes.** Nada sai da máquina; o usuário pode ver, exportar e apagar o que está salvo.
5. **Preparado para crescer.** O modo campeonato é futuro, mas a estrutura de dados e de código já deve acomodá-lo sem reescrever o que existe.

---

## 2. Decisões Técnicas do Frontend

| Decisão | Escolha | Justificativa |
| :--- | :--- | :--- |
| Linguagem | JavaScript (ES Modules) | Padrão do projeto |
| Framework | **Vanilla JS com ES Modules, sem etapa de build** | Coerente com a decisão de servir `pitchy` como módulo local (`ARCHITECTURE.md` 12.2); menos dependências; depuração direta no navegador |
| Servir arquivos | O próprio backend Node serve `frontend/` como estático, **na mesma origem** da API | Elimina CORS, simplifica o `Referer` do embed do YouTube e as permissões de microfone |
| Navegação | Roteador simples por *hash* (`#/jogo/:videoId`) | Sem dependência; botão voltar do navegador funciona |
| Estado global | Store pequena própria (objeto + eventos `subscribe`) | Suficiente para o tamanho do app |
| Estilo | CSS com variáveis (tokens), tema claro/escuro via `prefers-color-scheme` e override do usuário | Telas de karaokê são frequentemente usadas em ambiente escuro |
| Idioma | pt-BR como padrão; textos em arquivo único de strings (`i18n/pt-BR.json`) | Permite traduzir depois sem caçar texto no código |
| Navegador alvo | Chromium primeiro; Firefox/Safari com limitações (`ARCHITECTURE.md` 8.3) | Seleção de saída de áudio depende do navegador |

> **Evolução:** se a complexidade exigir React no futuro, a separação em módulos da seção 9 permite migrar a camada de UI mantendo `audio/`, `game/` e `api` intactos.

---

## 3. Modos de Jogo

### 3.1 Modo Karaokê Padrão (escopo atual)
Um jogador escolhe uma música, canta e recebe a nota de `0.0` a `10.0`. É o único modo implementado agora. Fluxo completo na seção 5.

### 3.2 Modo Campeonato (escopo futuro: **não implementar agora**)
Reservado para uma fase futura. Nesta versão, o frontend apenas:
* exibe na tela inicial um cartão **"Modo Campeonato — Em breve"**, desabilitado;
* possui a **abstração de modo de jogo** (3.3) e os campos de dados (`mode`, `session_id`) já previstos;
* não contém nenhuma regra de campeonato.

Ideias para o futuro (apenas registro, sem compromisso): vários jogadores em rodadas, mesma música ou músicas sorteadas, placar acumulado, critérios de desempate, chaveamento. Quando for projetado, deve ganhar documento próprio (`CHAMPIONSHIP_MODE.md`).

### 3.3 Abstração de Modo de Jogo (para não reescrever depois)
Todo modo implementa a mesma interface, registrada em um *registry* de modos:

| Elemento | Responsabilidade |
| :--- | :--- |
| `id` | Identificador do modo (`standard`, futuramente `championship`) |
| `setup(context)` | Telas e escolhas antes de cantar (jogador, música, dificuldade) |
| `onStart(session)` | Início da partida |
| `onFrame(frame)` | Reage a cada frame de pontuação (feedback em tempo real) |
| `onEnd(result)` | Fecha a partida e decide o que gravar |
| `summary(result)` | Conteúdo da tela de resultado |

* O `scoringEngine` e o `AudioEngine` **não conhecem modos**: o modo apenas os usa.
* Uma partida sempre é descrita por uma **sessão** (`session`) com `mode`, jogadores e música. No modo padrão, `session_id` é `null`; no campeonato, agrupará várias partidas.

---

## 4. Jogadores e Histórico

### 4.1 Objetivo
Permitir que o usuário informe seu nome e que o sistema guarde, em arquivo local, **quem cantou, qual música, quando e com qual nota**, formando um histórico consultável e exportável.

### 4.2 Perfil do Jogador
* Campo "Quem vai cantar?" no início do fluxo (e na tela de pré-jogo), com lista de jogadores recentes para escolha rápida.
* **Modo convidado:** cantar sem nome é permitido; a partida é gravada como "Convidado" (ou não gravada, conforme preferência nas Configurações).
* **Regras do nome:** 1 a 30 caracteres, espaços nas pontas removidos, acentos e emojis permitidos, caracteres de controle removidos, comparação de duplicados sem diferenciar maiúsculas/minúsculas.
* **Segurança de exibição:** todo nome é renderizado como **texto** (`textContent`), nunca como HTML.
* Ações: criar, selecionar, renomear, excluir jogador (ao excluir, perguntar se o histórico dele também será apagado ou mantido como "Jogador removido").
* O último jogador selecionado é lembrado entre sessões (`localStorage`).

### 4.3 O Que É Gravado
Ao **concluir** uma partida (música chegou ao fim), o frontend envia uma entrada de histórico ao backend. Partidas abandonadas não entram no ranking; podem ser gravadas com `completed: false` se o usuário ativar essa opção (desligada por padrão).

**Entrada de histórico:**
```json
{
  "id": "uuid",
  "player_id": "p_ana_1a2b",
  "player_name": "Ana",
  "mode": "standard",
  "session_id": null,
  "video_id": "abc123XYZ_0",
  "song_title": "Evidências",
  "artist": "Chitãozinho e Xororó",
  "played_at": "2026-11-14T20:31:05-03:00",
  "duration_s": 241,
  "score": 8.7,
  "completed": true,
  "difficulty": "normal",
  "compatibility_level": "good",
  "scoring_confidence": "high",
  "mic_quality": "acceptable",
  "assists": { "auto_transpose": false, "guide_volume": 0.3 },
  "details": { "best_streak": 42, "coverage": 0.83 },
  "scoring_version": 1,
  "app_version": "0.1.0"
}
```
Justificativas dos campos além do básico (jogador, música, nota):
* `difficulty`, `compatibility_level`, `scoring_confidence`, `mic_quality`, `assists`: **uma nota 9.0 em Difícil e uma 9.0 em Fácil não são equivalentes**; sem esses campos o histórico induz comparações injustas.
* `scoring_version`: se o motor de pontuação for recalibrado, notas antigas não devem ser comparadas às novas como se fossem iguais.
* `player_name`: cópia do nome no momento da partida (o histórico continua legível mesmo se o jogador for renomeado ou removido).

### 4.4 Armazenamento
O navegador não grava arquivos em disco por conta própria, e `localStorage` não atende ao requisito de "arquivo local". Portanto, **o backend persiste os dados**:

```text
backend/data/
├── players.json     # Perfis de jogadores
├── history.json     # Histórico de partidas
└── backups/         # Cópias rotativas automáticas
```

* **Formato principal: JSON** (com `schema_version`), por manter estrutura, tipos e evolução de campos. Os formatos CSV e TXT são **exportações** geradas sob demanda, não a fonte de verdade.
* **Escrita segura:** serializar gravações em fila única; escrever em arquivo temporário e renomear (gravação atômica); manter backup rotativo. Se o JSON estiver corrompido na leitura, mover para `*.corrupt-<data>`, avisar o usuário e iniciar um novo arquivo sem perder o corrompido.
* **Crescimento:** volume esperado é pequeno (centenas a poucos milhares de entradas). Se um dia passar disso, migrar para SQLite sem mudar o contrato da API.

**Exportação CSV** (UTF-8, com opção de BOM para abrir corretamente no Excel):

| Coluna | Observação |
| :--- | :--- |
| `data_hora` | ISO local |
| `jogador` | Nome |
| `modo` | `standard` |
| `musica` / `artista` | Texto |
| `nota` | `0.0` a `10.0` |
| `dificuldade` | fácil / normal / difícil |
| `compatibilidade` | Nível da música |
| `concluida` | sim / não |

Padrões de exportação para pt-BR: separador `;` e vírgula decimal (opção de trocar por `,` e ponto nas Configurações). **TXT:** relatório legível por jogador (uma linha por partida).

### 4.5 Telas e Funcionalidades de Histórico
* Lista cronológica com filtros por jogador, música, período e dificuldade.
* **Recorde pessoal** por música e **ranking local** por música (somando jogadores).
* Por jogador: total de partidas, média, melhor nota, músicas mais cantadas.
* Indicação visual quando uma nota veio de música de compatibilidade Baixa ou de dificuldade Fácil.
* Botões: exportar CSV/TXT, apagar histórico de um jogador, apagar tudo (com confirmação).

---

## 5. Telas e Fluxo de Navegação

### 5.1 Mapa de Rotas (hash)

| Rota | Tela |
| :--- | :--- |
| `#/` | Início (escolha de modo, jogador, busca) |
| `#/busca?q=` | Resultados da busca |
| `#/preparo/:videoId` | Preparo da música (progresso do job) |
| `#/pre-jogo/:videoId` | Resumo antes de cantar |
| `#/jogo/:videoId` | Partida |
| `#/resultado/:entryId` | Resultado da partida |
| `#/biblioteca` | Músicas já processadas |
| `#/historico` | Histórico e rankings |
| `#/configuracoes` | Áudio, calibração, aparência, dados |

### 5.2 Fluxo Principal (modo padrão)

```text
Início ─> Escolher jogador ─> Buscar ─> Resultados ─> [escolhe uma música]
   ─> Preparo (progresso + compatibilidade provisória) ─> Pré-jogo
   ─> (contagem regressiva) ─> Jogo ─> Resultado ─> [Jogar de novo | Outra música | Histórico]
```

### 5.3 Descrição das Telas

**Início:** cartões de modo (Karaokê ativo; Campeonato desabilitado "Em breve"), seletor de jogador, campo de busca, atalhos para Biblioteca e Histórico. Na primeira execução, direciona ao **assistente de configuração** (permissão de microfone, escolha de dispositivos, calibração; `ARCHITECTURE.md` 7.3 e 8).

**Resultados da busca:** thumbnail, título, canal, duração, indicador de letra sincronizada. **Sem selo de compatibilidade aqui** (`ARCHITECTURE.md` 10.1).

**Preparo:** etapas visíveis (*Na fila → Baixando áudio → Separando voz → Gerando gabarito → Analisando compatibilidade → Pronto*), percentual, estimativa de tempo, botão cancelar. Exibe a **compatibilidade provisória** e, ao final, a **final**. Se a música já estiver em cache, esta tela é pulada.

**Pré-jogo:** selo de compatibilidade com motivos; ações *Jogar assim mesmo* / *Escolher outra versão* / *Ajustar letra*; ajustes rápidos (dificuldade, volume da voz guia, mostrar vídeo, offset de latência); confirmação do jogador. O botão de iniciar exige uma interação do usuário, o que também satisfaz a política de *autoplay* do navegador.

**Jogo:** ver seção 7.

**Resultado:** nota, gráfico de desempenho ao longo da música, melhor sequência, comparação com o recorde pessoal, aviso de confiança quando a compatibilidade for Regular ou menor, botões de próxima ação. A entrada já foi gravada no histórico.

**Biblioteca:** músicas em cache com selo de compatibilidade, última vez cantada, ações (cantar, ajustar letra, reprocessar, remover).

**Configurações:** Áudio (entrada, saída, volumes, calibração, latência), Jogo (dificuldade padrão, mostrar vídeo, contagem regressiva), Aparência (tema, tamanho da letra), Dados (jogadores, histórico, exportar, apagar, caminho do cache e uso de disco), Sobre/Diagnóstico (resultado do `doctor`).

---

## 6. Vídeo do YouTube no Frontend

### 6.1 Decisão
**O vídeo aparece por padrão** na tela de jogo, como **palco visual**, mas é **opcional e escravo do áudio local** (`ARCHITECTURE.md` 6.C). O usuário pode desligá-lo (Configurações e Pré-jogo).

### 6.2 Comportamento
* Reproduzido **mudo**; o som vem do `AudioEngine`.
* Sincronização: a cada intervalo curto, compara o tempo do player com o relógio mestre e corrige com `seekTo` se a deriva passar de ~300 ms. Ver detalhes em `ARCHITECTURE.md` 6.C.5.
* **Layout:** vídeo como fundo ocupando a área do palco, levemente escurecido, com letra e pista de afinação sobrepostas para garantir legibilidade.
* **Estados tratados:** carregando, anúncio, travado, bloqueado para incorporação, erro. Em qualquer falha ou quando o usuário desligar o vídeo, a tela usa o **fundo alternativo** (thumbnail desfocada) e a partida continua sem interrupção.
* **Anúncios e Premium:** o jogo não depende de o Premium remover anúncios (`ARCHITECTURE.md` 6.C.1). O frontend não tenta bloquear anúncios.

### 6.3 Requisitos de Incorporação
* Como o frontend é servido pelo próprio backend em `localhost`, o embed envia um *referrer* válido; **não definir política de referrer que o suprima** (ex.: `no-referrer`), pois o player pode recusar reprodução sem ele.
* O domínio do embed deve ser **configurável** (padrão `youtube.com`; alternativa `youtube-nocookie.com`). A alternativa reduz rastreamento, mas pode alterar o comportamento de sessão/anúncios; o padrão mantém a chance de o benefício Premium se aplicar quando o usuário estiver logado.
* Vídeos com incorporação desativada ou restritos por idade usam o fundo alternativo automaticamente.

---

## 7. Tela de Jogo

### 7.1 Elementos

| Elemento | Descrição |
| :--- | :--- |
| **Palco** | Vídeo (ou fundo alternativo) em tela cheia da área de jogo |
| **Letra** | Linha atual em destaque, próximas linhas em menor ênfase, aplicando `offset_letra_ms`. Sem `.lrc`: letra estática com rolagem manual/proporcional |
| **Pista de afinação** (*pitch lane*) | Desenho em `canvas` do gabarito (barras de notas ao longo do tempo) e do cursor da voz do usuário |
| **Feedback em tempo real** | Indicação de acerto (cor/brilho) por frame e sequência atual |
| **Pontuação parcial** | Exibição opcional (ligar/desligar nas Configurações) |
| **Controles** | Pausar/retomar, volume da voz guia (0–100%), ajuste de letra, ajuste de latência, sair |
| **Medidor de microfone** | Pequeno indicador de nível/clareza para o usuário perceber se está sendo captado |
| **Avisos** | Vazamento de caixas ("use fones"), dispositivo removido, conexão com backend perdida |

### 7.2 Pista de Afinação e Pontuação Agnóstica de Oitava
Como a pontuação ignora a oitava (`ARCHITECTURE.md` 9.3), o cursor do usuário deve ser **desenhado dobrado para a oitava do gabarito** (mesma classe de nota). Assim, o jogador vê o cursor próximo da barra-alvo quando acerta a nota, independentemente de ser homem ou mulher. Sem isso, a interface sugeriria erro onde a pontuação considera acerto.

### 7.3 Ciclo de Vida da Partida
1. **Preparação:** carregar `AudioBuffer`s, `pitch_map.json`, letra e (se ligado) o player de vídeo. Exibir "carregando" até tudo estar pronto.
2. **Contagem regressiva** (3-2-1, configurável) e início sincronizado dos sources agendados no mesmo instante.
3. **Execução:** laço de renderização por `requestAnimationFrame` lendo o relógio mestre; pontuação alimentada pelo `scoringEngine`.
4. **Pausa:** suspende o `AudioContext` e congela pontuação e vídeo; ao retomar, reaproveita `offset_seek` (`ARCHITECTURE.md` 8.2).
5. **Fim:** ao terminar o instrumental, calcular a nota final, **gravar no histórico** e ir para a tela de resultado.
6. **Sair no meio:** confirmar; a partida é descartada (ou gravada como não concluída, se a opção estiver ativa).

### 7.4 Atalhos e Conforto
* Teclado: `Espaço` pausa, `Esc` abre o menu de pausa, `F` tela cheia, setas ajustam offset de letra durante a pausa.
* **Tela cheia** (Fullscreen API) e **bloqueio de suspensão de tela** (Screen Wake Lock API, quando disponível) durante a partida.
* Interface legível a distância (tamanho de letra configurável), pensada para uso em TV/monitor com computador ligado.

---

## 8. Estado, Preferências e Persistência no Cliente

### 8.1 Onde cada dado vive

| Dado | Local | Motivo |
| :--- | :--- | :--- |
| Jogadores e histórico | **Backend** (`backend/data/*.json`) | Requisito de arquivo local, exportável, sobrevive a limpar o navegador |
| Offsets por música (letra, latência) | **Backend** (`manifest.json`, `ARCHITECTURE.md` 12.1) | Pertencem à música |
| Dispositivos de áudio escolhidos, perfis de calibração por microfone | `localStorage` | Dependem do hardware daquele navegador/máquina |
| Último jogador, tema, dificuldade padrão, opções de exibição | `localStorage` | Preferências da interface |
| Estado da partida em andamento | Memória (store) | Efêmero |

Toda chave do `localStorage` usa prefixo (`karaoke.`) e `schema_version`; leituras e gravações ficam em `try/catch`, e a ausência de dados nunca pode quebrar a tela.

### 8.2 Store Global (campos principais)
`player` (ativo) · `mode` · `song` (manifest atual) · `job` (progresso do preparo) · `audioSettings` (dispositivos, volumes, latência) · `session` (partida atual) · `ui` (tema, tela cheia) · `connection` (estado do backend).

### 8.3 Comunicação com o Backend
* Módulo `api` único (REST + SSE de progresso) com tratamento padronizado de erros e *retry* para falhas de rede recuperáveis.
* Monitor de saúde do backend: se a conexão cair durante o **preparo**, a UI tenta reconectar ao SSE e consulta o estado do job; durante o **jogo**, a partida continua (arquivos já carregados em memória), e o gravamento no histórico é reenviado ao reconectar.

---

## 9. Organização de Módulos

Estende a árvore `frontend/` do `ARCHITECTURE.md` (seção 12); em caso de divergência de nomes, o documento principal prevalece.

```text
frontend/
├── index.html
├── styles/                    # tokens, base, temas, componentes
├── vendor/
│   └── pitchy.js              # Bundle ESM local (ARCHITECTURE.md 12.2)
├── i18n/
│   └── pt-BR.json
└── src/
    ├── app.js                 # Bootstrap, roteador, store
    ├── router.js
    ├── store.js
    ├── api.js                 # REST + SSE
    ├── settings/              # audioDevices.js, micCalibration.js (já definidos)
    ├── audio/                 # audioEngine.js, micCapture.js, pitchWorklet.js, pitchDetector.js
    ├── game/
    │   ├── scoringEngine.js
    │   ├── lyricSync.js
    │   ├── session.js         # Modelo de sessão/partida
    │   └── modes/
    │       ├── registry.js    # Registro de modos
    │       ├── standard.js    # Modo Karaokê Padrão
    │       └── championship.js# PLACEHOLDER (futuro): só reserva a interface
    ├── players/
    │   └── playerStore.js     # Perfis, seleção, validação de nome
    ├── history/
    │   └── historyClient.js   # Gravar/consultar/exportar via API
    ├── video/
    │   └── youtubePlayer.js
    └── ui/
        ├── screens/           # home, search, prepare, pregame, game, result, library, history, settings
        ├── components/        # badge de compatibilidade, pitch lane, lyrics, medidor, cartões
        └── dialogs/           # confirmações, erros, primeiro uso
```

Regras de dependência: `ui/` pode usar tudo; `game/` e `audio/` **não** importam `ui/`; `audio/` não conhece modos de jogo nem histórico; `history/` e `players/` conversam apenas com `api`.

---

## 10. Estados de Erro e Mensagens da Interface

| Situação | Comportamento da interface |
| :--- | :--- |
| Backend fora do ar | Banner persistente "Servidor local não encontrado" + instruções de iniciar; ações de rede desabilitadas |
| Dependência ausente (`doctor`) | Tela de diagnóstico com o que falta e como instalar |
| Permissão de microfone negada | Mensagem clara e atalho para Configurações → Áudio |
| Nenhum microfone/saída | Orientação para conectar; botão "Procurar de novo" |
| Falha no preparo (download/separação) | Mensagem amigável, indicação se pode tentar de novo, opção de escolher outra versão |
| Vídeo indisponível | Fundo alternativo, sem alerta intrusivo |
| Música sem letra | Aviso discreto; partida segue só com melodia |
| Compatibilidade Baixa/Incompatível | Pré-jogo com motivos, alternativas e confirmação |
| Falha ao gravar histórico | Não perde a nota: mantém na tela de resultado, guarda na fila local e reenvia; permite exportar manualmente |
| Dispositivo removido durante a partida | Pausa automática e pedido de nova escolha |

---

## 11. Acessibilidade, Desempenho e Testes

### 11.1 Acessibilidade
Contraste adequado nos dois temas; letra com tamanho ajustável; navegação por teclado em todas as telas; rótulos para leitores de tela nos controles; não depender só de cor para indicar acerto (usar também forma/animação).

### 11.2 Desempenho
* Renderização da pista e da letra por `requestAnimationFrame`, sem recalcular layout a cada frame.
* Decodificação de áudio feita uma vez no carregamento; liberar buffers ao sair da partida.
* Pontuação e detecção não podem ser interrompidas por trabalho de interface (detecção fora da thread principal quando possível; `ARCHITECTURE.md` 12.2).

### 11.3 Testes
* Fluxo completo com uma música em cache (busca → pré-jogo → jogo → resultado → histórico).
* Criação, renomeação e exclusão de jogador; nomes com acento, emoji e tentativa de injeção de HTML.
* Gravação concorrente de histórico e arquivo corrompido (recuperação).
* Exportação CSV abrindo corretamente no Excel pt-BR.
* Falha de vídeo, ausência de letra e queda do backend durante o preparo e durante a partida.

### 11.4 Critérios de Aceitação do Frontend (MVP)
1. O usuário informa o nome, canta e a partida aparece no histórico com música e nota, persistida em arquivo no backend.
2. O histórico pode ser exportado em CSV e TXT, e os dados sobrevivem a limpar o navegador.
3. O cartão do modo Campeonato aparece como "Em breve" e não afeta nada.
4. O vídeo aparece por padrão e pode ser desligado; sua falha não interrompe a partida.
5. O selo de compatibilidade aparece após a escolha da música, e não na lista de resultados.
6. Pausar, trocar saída de áudio e retomar não reinicia a música.
7. A pista de afinação mostra o cursor dobrado para a oitava do gabarito.

---

## 12. Regras Herdadas do `ARCHITECTURE.md` (referência rápida)

A tabela abaixo **não substitui** o documento principal; serve de lembrete de que o frontend deve segui-las.

| Regra | Onde está |
| :--- | :--- |
| `AudioContext` é o relógio mestre; vídeo é escravo | 6.C |
| Anúncios/Premium não podem ser requisito | 6.C.1 |
| Captura do mic sem AEC/NS/AGC, filtro ~80–1200 Hz | 7.1, 7.2 |
| Calibração do mic, teste de vazamento, latência | 7.3, 7.5 |
| Robustez do detector (histerese, mediana, *hold*) | 7.4 |
| Seleção de entrada/saída, `devicechange`, suporte por navegador | 8 |
| Troca de saída preserva a posição (`offset_seek`) | 8.2 |
| Pontuação, tolerâncias, oitava agnóstica, nota final | 9 |
| Compatibilidade: duas fases e exibição após a escolha | 10 |
| Fallbacks (sem letra, vídeo karaokê, falhas) | 11 |
| `pitchy` como módulo local em `vendor/` | 12.2 |
| API, segurança local, `doctor` | 13 |

### 12.1 Alterações Necessárias no `ARCHITECTURE.md` (já aplicadas na v2.2)
Novas rotas de API para jogadores, histórico e exportação; pasta `backend/data/`; serviços `playerService.js` e `historyService.js`. Contratos das rotas na seção 13.

---

## 13. Contratos de API Exigidos pelo Frontend (jogadores e histórico)

| Rota | Função |
| :--- | :--- |
| `GET /api/players` | Lista jogadores |
| `POST /api/players` | Cria jogador (`{ name }`), valida e deduplica |
| `PATCH /api/players/:id` | Renomeia |
| `DELETE /api/players/:id?history=keep\|delete` | Remove jogador, mantendo ou apagando histórico |
| `GET /api/history?player_id=&video_id=&from=&to=&limit=` | Consulta histórico |
| `POST /api/history` | Grava uma entrada (formato de 4.3) |
| `DELETE /api/history/:id` | Remove uma entrada |
| `DELETE /api/history?player_id=` | Apaga histórico de um jogador (ou todo, com confirmação explícita) |
| `GET /api/history/export?format=csv\|txt&player_id=` | Exporta |
| `GET /api/history/rankings?video_id=` | Ranking local por música |

Todas as entradas são validadas no backend (tipos, limites de tamanho, faixa da nota `0.0`–`10.0`); o backend **nunca confia** no frontend para sanitização.

---

## 14. Roadmap do Frontend (alinhado às fases do `ARCHITECTURE.md`)

| Fase | Entregas de frontend |
| :--- | :--- |
| **0** | Nenhuma interface obrigatória; apenas página de diagnóstico simples (`doctor`) |
| **1** | Esqueleto (roteador, store, temas), tela de jogo com `AudioEngine`, letra e vídeo, modo padrão com música de teste |
| **2** | Assistente de configuração, Configurações → Áudio, calibração do microfone |
| **3** | Pista de afinação, feedback, resultado, dificuldades |
| **4** | Início, busca, preparo, pré-jogo com compatibilidade, biblioteca, **jogadores e histórico**, exportações, cartão "Em breve" do campeonato, polimento e acessibilidade |
| **Futuro** | Modo Campeonato (documento próprio) |

---

## 15. Diretrizes Finais para Agentes de Código

1. **Não repetir** regras do `ARCHITECTURE.md`; referenciá-las e segui-las.
2. **Sem etapa de build** no fluxo normal; ES Modules servidos estaticamente (`vendor/` para bibliotecas).
3. **Persistência de jogador/histórico apenas via backend**, em JSON com gravação atômica; CSV/TXT são exportações.
4. **Nunca renderizar nome de jogador ou título como HTML**; usar texto.
5. **Implementar o modo padrão atrás da abstração de modos** (3.3), e manter o campeonato como placeholder desabilitado.
6. **A interface não pode derrubar a partida** por falha de vídeo, letra ou histórico.
7. **Todo limiar e opção de exibição configurável** fica em `config/` ou nas preferências, nunca como constante espalhada.
8. **Sempre registrar `difficulty`, `compatibility_level`, `scoring_version`** em cada entrada de histórico.
