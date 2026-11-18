# Especificação Técnica: Evolução do Sistema de Pontuação, Pista Visual e Experiência de Jogo

**Projeto:** `game-karaoke-by-willian`  
**Versão do Documento:** 1.0  
**Status:** Proposta Técnica Aprovada para Implementação (Pós-MVP v1)  
**Documentos Relacionados:** `docs/ARCHITECTURE.md` (v2.2), `docs/FRONTEND_ARCHITECTURE.md` (v1.0), `docs/CONTRACTS.md` (v1)

---

## 1. Resumo Executivo

Após a conclusão e validação do MVP (Fases 0 a 4), testes práticos realizados em ambiente real evidenciaram oportunidades importantes de melhoria na **justiça da pontuação** e na **experiência de jogo (UX)** durante as partidas de karaokê.

Este documento especifica cinco melhorias integradas:
1. **Bloqueio de penalização em trechos sem letra** (janelas ativas de canto guiadas pelo `.lrc`).
2. **Modelo Híbrido de Pontuação (Afinação + Sincronia Rítmica da Letra)** com pesos progressivos por dificuldade (`30/70`, `40/60`, `60/40`).
3. **Transposição Automática de Tom ativada por padrão nas dificuldades Fácil e Normal** (mantendo tom original estrito apenas no Difícil).
4. **Revelação do placar numérico exclusivamente na Tela de Resultado** (ocultando a pontuação parcial por padrão durante a partida).
5. **Assistência Visual Magnética (*Pitch Snap*) na Pista de Afinação** proporcional à dificuldade escolhida.

---

## 2. Diagnóstico dos Problemas Atuais

### 2.1 Penalização indevida durante pausas, introduções e solos instrumentais
* **Sintoma observado:** Durante introduções longas, interlúdios instrumentais, solos de guitarra ou pausas entre estrofes, a pontuação acumulada do jogador cai progressivamente mesmo quando não há nenhum verso a ser cantado na tela.
* **Causa raiz técnica:** O motor atual (`scoringEngine.js`) avalia todos os frames do `pitch_map.json` em que `midi !== null` e `conf >= pitch_conf_threshold`. Entretanto, em gravações reais separadas por IA, vocalizações sem letra (*"ahn"*, *"oh"*), *backing vocals*, ecos de estúdio e resquícios instrumentais no stem `vocals.flac` frequentemente ultrapassam o limiar de confiança (`0.60`). Como não há verso na letra naquele instante, o jogador permanece em silêncio e recebe `0` pontos por frame.

### 2.2 Rigor excessivo da nota baseada exclusivamente em afinação absoluta
* **Sintoma observado:** Jogadores amadores que cantam toda a música no ritmo correto, acompanhando a letra sincronizada e com boa participação vocal (ex.: ~69% de cobertura), recebem notas finais muito baixas (faixa de `2,7` a `3,9` mesmo no modo **Fácil**).
* **Causa raiz técnica:**
  1. A nota atual (`10 * soma(pontos) / frames_contados`) depende **100%** da proximidade melódica em relação ao cantor original. Usuários sem treinamento vocal naturalmente oscilam em torno da nota-alvo.
  2. Embora o cálculo seja agnóstico de oitava ($\bmod 12$), a **transposição automática** (`auto_transpose`) vem desligada por padrão. Se um jogador canta confortavelmente 2 ou 3 semitons acima ou abaixo da gravação original (adaptação natural de tessitura vocal), todos os frames são penalizados mesmo que a melodia relativa esteja afinada.

### 2.3 Ansiedade e distração causadas pela pontuação numérica em tempo real
* **Sintoma observado:** Exibir a nota numérica flutuando a cada segundo no topo da tela durante a partida desvia a atenção da letra e gera frustração imediata quando o valor oscila nos primeiros versos (antes da estabilização da transposição automática).
* **Causa raiz técnica e de UX:** O cálculo da média acumulada nos primeiros segundos tem variância alta. Além disso, a avaliação rítmica por verso da letra ganha muito mais precisão quando consolidada frase a frase e apresentada como resumo completo apenas na tela de resultado.

### 2.4 Rigidez visual do cursor na pista de afinação no modo Fácil
* **Sintoma observado:** Na pista de afinação (`pitchLane.js`), o cursor do usuário reflete exatamente cada micro-oscilação do detector de F0 (`pitchy`). Em microfones amadores ou vozes com vibrato/instabilidade natural, o cursor "trepida" fora da barra-alvo mesmo quando o sistema está contabilizando pontos de acerto.
* **Causa raiz técnica e de UX:** Falta de acoplamento visual (*magnetic snap*) entre a tolerância da dificuldade escolhida e a posição renderizada do cursor na pista.

---

## 3. Especificação Técnica das Soluções

### 3.1 Janelas Ativas de Canto (Fim da queda de nota fora da letra)

#### Solução Técnica
Quando a música possuir letra sincronizada (`lyrics.type === "synced"` e linhas válidas no `.lrc`), o motor construirá uma lista de **janelas ativas de canto** $[t_{\text{início}} - m_{\text{pre}},\; t_{\text{fim}} + m_{\text{pos}}]$ a partir dos timestamps de cada verso:
* $t_{\text{início}}$: timestamp da linha atual no `.lrc`.
* $t_{\text{fim}}$: timestamp da próxima linha (limitado a uma duração máxima razoável por verso, ex.: `12 s`, caso haja uma pausa instrumental longa antes da estrofe seguinte) ou fim do áudio na última linha.
* $m_{\text{pre}} = 0,5\text{ s}$ e $m_{\text{pos}} = 0,5\text{ s}$: margens de tolerância configuráveis (`scoring.lyric_window_margin_s`) para acomodar antecipações e sustentações naturais do cantor.

Qualquer frame cujo `songTime` esteja **fora** dessas janelas ativas é imediatamente descartado da avaliação (`counted: false`), independentemente de haver energia residual em `pitch_map.json`.

#### Fallback sem letra sincronizada
Caso a música tenha apenas letra estática (`plain`) ou nenhuma letra (`none`), o motor utiliza os blocos contínuos de voz detectados no próprio `pitch_map.json` (descartando ilhas isoladas menores que `0,4 s`, típicas de resquícios instrumentais ou respiração).

#### Justificativa
Garante alinhamento total entre o que o jogador **vê na tela** (letra) e o que o sistema **cobra na pontuação**, eliminando penalizações injustas em introduções, solos e pausas.

---

### 3.2 Modelo Híbrido de Pontuação (Afinação + Sincronia da Letra)

#### Definição dos Dois Pilares
A nota final (`0.0` a `10.0`) passa a ser a média ponderada de dois sub-escores normalizados entre `0.0` e `10.0`:

$$\text{Nota}_{\text{Final}} = w_{\text{afinação}} \cdot \text{Nota}_{\text{Afinação}} + w_{\text{letra}} \cdot \text{Nota}_{\text{Letra}}$$

1. **Parcela de Afinação ($\text{Nota}_{\text{Afinação}}$, `0.0` a `10.0`):**
   * Mantém o cálculo melódico circular ($\bmod 12$) sobre os frames contados dentro das janelas ativas, respeitando as tolerâncias (`full` e `half`) de cada dificuldade.
2. **Parcela de Sincronia da Letra / Presença Rítmica ($\text{Nota}_{\text{Letra}}$, `0.0` a `10.0`):**
   * Avalia **cada verso sincronizado** (ou bloco vocal no fallback) como uma unidade rítmica:
     * **Cobertura do verso ($C_v \in [0, 1]$):** proporção de frames dentro da janela do verso em que o microfone detectou voz ativa válida do jogador (`userMidi !== null` ou RMS acima do gate de canto).
     * **Pontualidade de entrada ($E_v \in [0, 1]$):** verifica se o jogador iniciou o canto próximo ao início esperado do verso (penalizando apenas atrasos superiores a `0,8 s` ou entradas totalmente perdidas).
     * **Score do verso:** $S_v = 0,85 \cdot \min\left(1, \frac{C_v}{0,65}\right) + 0,15 \cdot E_v$ (atingir 65% ou mais de presença vocal dentro do tempo do verso garante pontuação cheia de presença rítmica, acomodando respirações naturais entre palavras).
     * $\text{Nota}_{\text{Letra}} = 10 \cdot \frac{\sum_{v} S_v}{\text{Total de Versos}}$.

#### Pesos por Dificuldade

| Dificuldade | Peso Afinação ($w_{\text{afinação}}$) | Peso Sincronia da Letra ($w_{\text{letra}}$) | Transposição Automática Padrão |
| :--- | :---: | :---: | :---: |
| **Fácil** (`easy`) | **30%** (`0.30`) | **70%** (`0.70`) | **Ativada** (`true`) |
| **Normal** (`normal`) | **40%** (`0.40`) | **60%** (`0.60`) | **Ativada** (`true`) |
| **Difícil** (`hard`) | **60%** (`0.60`) | **40%** (`0.40`) | **Desativada** (`false`) |

#### Justificativa
* **Por que não usar reconhecimento de fala (Speech-to-Text)?** Modelos de transcrição vocal em tempo real sobre música geram latência elevada, consomem recursos significativos de CPU/GPU e sofrem alta taxa de erro em notas sustentadas ou agudas. A avaliação de **presença vocal dentro da janela temporal exata de cada verso sincronizado** roda em $< 0,1\text{ ms}$ por frame, 100% offline no navegador e captura com precisão se o jogador cantou cada frase na hora certa.
* **Justiça progressiva:** No **Fácil**, cantar a letra inteira no tempo certo já assegura uma base sólida (~7,0 pontos), enquanto a afinação eleva a nota até 10,0. No **Difícil**, a afinação volta a ser predominante (60%) e exige o tom original da gravação.
* **Transposição automática inteligente:** Ativar `auto_transpose` por padrão no **Fácil** e **Normal** (quando o usuário não sobrescrever manualmente nas Configurações) permite que vozes masculinas, femininas e infantis cantem qualquer música em seu registro natural sem serem penalizadas por diferenças de tonalidade em relação ao artista original.

---

### 3.3 Exibição do Placar Apenas na Tela de Resultado

#### Solução Técnica
* Alterar o valor padrão da preferência `showPartialScore` para `false` (desligado por padrão).
* Durante a execução da partida (`gameView.js`), o HUD superior exibe apenas:
  * **Sequência atual (*Streak*)** e **indicador visual de acerto** (brilho nas barras da pista).
  * O placar numérico (`0.0`–`10.0`) permanece oculto durante a música (podendo ainda ser reativado manualmente em *Configurações $\rightarrow$ Gameplay* por usuários que desejarem).
* Na **Tela de Resultado (`resultView.js`)**, a nota final é revelada em destaque acompanhada do **detalhamento transparente** dos dois componentes:
  * **Nota Final** (ex.: `8,4`)
  * **Afinação Melódica** (ex.: `7,2` — peso 40%)
  * **Sincronia da Letra** (ex.: `9,2` — peso 60%)

#### Justificativa
* Elimina a ansiedade de ver números oscilando enquanto se lê a letra.
* Cria um momento de expectativa e recompensa ao final da música.
* Evita mostrar notas intermediárias distorcidas antes que a transposição automática estabilize o deslocamento tonal nos primeiros versos.

---

### 3.4 Assistência Visual Magnética (*Pitch Snap*) na Pista de Afinação

#### Solução Técnica
Na renderização do cursor do usuário em `pitchLane.js`, após dobrar a nota cantada para a oitava da barra-alvo atual ($\text{MIDI}_{\text{dobrado}}$), aplica-se uma interpolação magnética em direção ao centro da barra ($\text{MIDI}_{\text{alvo}}$) baseada na distância circular $\Delta$ e no fator de magnetismo $\alpha$ da dificuldade:

$$\text{MIDI}_{\text{exibido}} = \begin{cases}
\text{MIDI}_{\text{dobrado}} + \alpha \cdot (\text{MIDI}_{\text{alvo}} - \text{MIDI}_{\text{dobrado}}), & \text{se } \Delta \le \Delta_{\text{snap}} \\
\text{MIDI}_{\text{dobrado}}, & \text{se } \Delta > \Delta_{\text{snap}}
\end{cases}$$

Parâmetros por dificuldade:
* **Fácil (`easy`):** $\alpha = 0,85$ (85% de atração ao centro da barra) dentro de $\Delta_{\text{snap}} = 2,2\text{ semitons}$. O cursor desliza suavemente colado no centro das barras quando o jogador canta próximo da melodia, soltando-se apenas se errar por mais de um tom inteiro ou parar de cantar.
* **Normal (`normal`):** $\alpha = 0,45$ (45% de suavização) dentro de $\Delta_{\text{snap}} = 1,5\text{ semitons}$. Reduz tremores naturais do microfone mantendo feedback fiel de desvio.
* **Difícil (`hard`):** $\alpha = 0,0$ (sem magnetismo). Exibe o traçado vocal puro (apenas dobrado para a oitava do gabarito).

#### Justificativa
Consistência sensorial entre **o que o jogador vê** e **o que o sistema pontua**: se o modo Fácil considera um desvio de até `2,0 semitons` como acerto parcial/total, mostrar o cursor visualmente alinhado à barra reforça o reforço positivo e torna a pista de afinação prazerosa de acompanhar.

---

## 4. Plano de Arquivos Afetados e Impacto

| Arquivo | Tipo de Alteração | Descrição Técnica |
| :--- | :--- | :--- |
| `config/default.json` | Modificação | Adicionar bloco `scoring.weights_by_difficulty` (`easy`, `normal`, `hard`), `scoring.lyric_window_margin_s`, `scoring.auto_transpose_by_difficulty` e `scoring.visual_snap`. |
| `backend/routes/config.js` | Verificação / Ajuste | Garantir que `GET /api/config` exponha os novos parâmetros de `scoring` ao frontend. |
| `backend/services/historyService.js` | Modificação (retrocompatível) | Aceitar campos opcionais em `details` (`pitch_score`, `lyric_score`, `weights_used`) mantendo `schema_version: 1` compatível com registros antigos. |
| `frontend/src/game/scoringEngine.js` | Modificação principal | Implementar janelas ativas baseadas nas linhas `.lrc`, cálculo de `lyric_score` por verso, ponderação híbrida por dificuldade, `autoTranspose` padrão por dificuldade e retorno de `{ score, pitch_score, lyric_score, ... }` em `summary()`. |
| `frontend/src/ui/components/pitchLane.js` | Modificação | Adicionar suporte ao parâmetro `difficulty` / `snapConfig` para aplicar o *pitch snap* magnético no cursor do usuário. |
| `frontend/src/views/playView.js` | Modificação | Passar as linhas parseadas do `.lrc` ao `scoringEngine`, passar a dificuldade ao `pitchLane` e manter o placar numérico oculto por padrão durante a partida. |
| `frontend/src/views/resultView.js` | Modificação | Exibir a composição da nota (**Afinação** vs. **Sincronia da Letra** com seus respectivos pesos) ao lado da nota final. |
| `frontend/src/views/settingsView.js` | Modificação | Ajustar o valor padrão de `showPartialScore` para `false` e exibir descrição clara dos pesos por dificuldade na aba *Gameplay*. |
| `frontend/i18n/pt-BR.json` | Modificação | Adicionar chaves de tradução para detalhamento de Afinação, Sincronia de Letra e descrição das dificuldades. |
| `scripts/test-scoring.js` | Modificação | Atualizar os testes existentes e adicionar casos para: (1) silêncio fora das janelas `.lrc` não reduzindo nota, (2) cálculo híbrido `30/70`, `40/60` e `60/40`, e (3) retrocompatibilidade sem `.lrc`. |

---

## 5. Critérios de Aceitação da Melhoria

1. **Pausas e introduções:** Em uma música com `.lrc`, permanecer em silêncio durante uma introdução de 20 segundos antes do primeiro verso não reduz a nota final.
2. **Proporção de pesos:**
   * No modo **Fácil**, acertar 100% da sincronia da letra com 0% de acerto melódico resulta em nota **7,0**.
   * No modo **Normal**, o mesmo cenário resulta em nota **6,0**.
   * No modo **Difícil**, o mesmo cenário resulta em nota **4,0**.
3. **UX durante o jogo:** Ao iniciar uma partida com configurações padrão, o número da nota não aparece na tela de canto, sendo revelado apenas na tela de resultado com o detalhamento entre *Afinação* e *Sincronia da Letra*.
4. **Assistência visual:** No modo **Fácil**, cantar a 1 semitom de distância da nota-alvo exibe o cursor alinhado sobre a barra na pista de afinação; no modo **Difícil**, o cursor exibe o deslocamento real.
5. **Regressão zero:** Todos os 56 testes automatizados existentes continuam passando após a atualização.
```

O documento técnico foi salvo como `docs/MELHORIAS_PONTUACAO_EXPERIENCIA.md`. Quando quiser partir para a implementação dessas melhorias no código do projeto, é só avisar!