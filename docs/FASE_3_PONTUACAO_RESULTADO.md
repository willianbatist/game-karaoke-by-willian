# Fase 3 — Motor de Pontuação, Pista de Afinação e Resultado

> Status das tasks: **somente neste arquivo** (fonte única). Painel de handoff e regras: `docs/tasks/TASKS.md`. Formatos: `docs/CONTRACTS.md`.

**Referências:** `ARCHITECTURE.md` (Seções 9, 11.1, 14.2) e `FRONTEND_ARCHITECTURE.md` (Seções 5.3, 7, 11.1, 11.2). Tempo e interface do motor: `docs/CONTRACTS.md` §6 e §7.
**Objetivo:** Implementar o algoritmo de avaliação vocal (`0.0` a `10.0`) agnóstico de oitava, renderizar a pista de afinação em `<canvas>` com dobramento visual de oitava, completar a experiência da tela de jogo e validar a precisão matemática do motor.

---

### `T3.1` — `ScoringEngine` (MIDI circular mod 12, dificuldades, heurística, transposição)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/game/scoringEngine.js`
* **Detalhes de Implementação:**
  * **Alinhamento Temporal:** cada frame do detector chega com `songTime` (centro da janela, `CONTRACTS.md` §6). Calcula `t_efetivo = songTime - latencyOffsetMs / 1000` e `idx = Math.round((t_efetivo - pitchMap.t0) / pitchMap.hop)`. `idx` fora de `[0, midi.length)` ⇒ frame ignorado.
  * **Regras de Contagem (Seção 9.5):**
    * Se `pitchMap.midi[idx] === null` ou `pitchMap.conf[idx] < config.pitch_conf_threshold`: frame **ignorado** (não soma nem penaliza).
    * Se o gabarito exige voz e o usuário está mudo (`userMidi === null`): frame contado com `0` pontos.
  * **Distância Agnóstica de Oitava (Seção 9.3):**
    $$d = |\text{MIDI}_{\text{usuário}} - \text{MIDI}_{\text{gabarito}}| \bmod 12, \qquad \Delta = \min(d,\; 12 - d)$$
  * **Tolerâncias por Dificuldade (Seção 9.4 — lidas de `config/default.json`):**
    * $\Delta \le \text{full}$ $\to$ `1.0` ponto (`hit: "perfect"`).
    * $\text{full} < \Delta \le \text{half}$ $\to$ `0.5` ponto (`hit: "good"`).
    * $\Delta > \text{half}$ $\to$ `0.0` ponto (`hit: "miss"`).
  * **Modo Heurístico (Seção 11 — Vídeos já Karaokê/Instrumental):** quando `pitchMap.mode === "heuristic"`, usa a definição mínima de `CONTRACTS.md` §7 (frames estáveis ÷ cobertura mínima), com parâmetros em `config.scoring.heuristic` (criar o bloco em `config/default.json` nesta task) e `scoring_confidence: "low"`.
  * **Transposição Automática Opcional (Seção 9.7):** Desligada por padrão; quando ativada pelo usuário, estima o desvio circular dominante nos primeiros trechos cantados e aplica o deslocamento antes de calcular $\Delta$.
  * **Cálculo Final (Seção 9.6):**
    $$\text{Nota} = 10 \cdot \frac{\sum_{i \in \text{contados}} p_i}{\#\text{contados}}$$
    Interface (`createScoringEngine`, `pushFrame`, `summary`) e campos retornados (`segments`, `best_streak`, `coverage`, `scoring_confidence`, `transposition_semitones`): `CONTRACTS.md` §7.
* **Critérios de Aceitação:**
  * Motor é um módulo puro (sem DOM e sem `fetch`; tolerâncias e parâmetros entram por argumento), importável pelo Node; retorna nota formatada de `0.0` a `10.0` e metadados completos para o histórico.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T3.2` — Pista de Afinação (`pitchLane.js` com dobramento de oitava do cursor)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/ui/components/pitchLane.js`
* **Detalhes de Implementação:**
  * Renderização via HTML5 `<canvas>` sincronizada por `requestAnimationFrame` lendo `audioEngine.getCurrentTime()` (sem causar *layout thrashing*).
  * Desenha uma janela deslizante de tempo (ex.: `2 s` passados + `4 s` futuros) mostrando as barras de notas do `pitch_map.json` (apenas frames com `conf >= threshold`).
  * **Dobragem Visual de Oitava (`FRONTEND_ARCHITECTURE.md` Seção 7.2 — CRÍTICO):**
    * Como a pontuação é agnóstica de oitava, o cursor do usuário **deve** ser projetado para a mesma oitava da nota-alvo atual do gabarito:
      $$\text{MIDI}_{\text{visual}} = \text{MIDI}_{\text{gabarito}} + \text{signedCircularDiff}(\text{MIDI}_{\text{usuário}}, \text{MIDI}_{\text{gabarito}})$$
      onde $\text{signedCircularDiff} \in [-6, +6]$. Isso garante que vozes graves e agudas vejam o cursor alinhado sobre a barra quando acertam a nota.
  * **Sem nota-alvo no frame atual:** o cursor usa a oitava da última nota-alvo presente na janela passada visível; se não houver nenhuma, não é desenhado.
  * **Acessibilidade Visual (Seção 11.1):** Indicar acerto não apenas por cor (verde/dourado), mas também por brilho/espessura da barra e partículas/pulso na linha do tempo presente.
* **Critérios de Aceitação:**
  * Cantar uma oitava abaixo ou acima da nota-alvo exibe o cursor perfeitamente alinhado à barra na pista de afinação.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T3.3` — Tela de Jogo Completa (contagem, pausa, atalhos, Wake Lock, avisos)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/ui/screens/game.js` (evolução completa)
  * `frontend/src/ui/components/micMeter.js`
* **Detalhes de Implementação:**
  * **Ciclo de Vida (`FRONTEND_ARCHITECTURE.md` Seção 7.3):**
    1. Carregamento de `AudioBuffer`s, `pitch_map.json`, letra e player de vídeo.
    2. Contagem regressiva visual `3 - 2 - 1` (configurável) antes do início sincronizado.
    3. Execução com pista de afinação (`pitchLane`), letra (`lyricsDisplay`), pontuação parcial opcional, sequência atual e `micMeter` discreto.
    4. Menu de Pausa (`Space` ou `Esc`): opções *Continuar*, *Ajustar Letra*, *Ajustar Latência*, *Volume Voz Guia*, *Configurações de Áudio*, *Reiniciar* e *Sair*.
  * **Atalhos e Conforto (Seção 7.4):**
    * `Espaço`: pausar/retomar; `Esc`: abrir/fechar menu de pausa; `F`: alternar tela cheia (`Fullscreen API`); `Seta Esquerda / Direita` durante pausa: ajustar offset da letra em `±100 ms`.
    * Solicitar `navigator.wakeLock.request('screen')` ao iniciar a partida e liberar ao sair.
  * **Modo heurístico:** se `pitch_map.mode === "heuristic"`, desativar a letra externa (a arquitetura, seção 11, indica que o próprio vídeo traz a letra) e informar o usuário.
  * **Avisos Não-Bloqueantes:** Banner discreto para vazamento de caixa de som ("Use fones de ouvido para uma pontuação mais justa"), perda de conexão com backend (mantém partida em memória) e modal de pausa imediata se dispositivo de áudio for removido. Usar `banner.js` e `confirm.js` criados na T1.4.
* **Critérios de Aceitação:**
  * Todos os atalhos de teclado funcionam; tela não entra em descanso durante a música; sair no meio pede confirmação.
* **Subtarefas (pré-definidas; atualizar o status de cada uma):**
  * `[ ] T3.3.1` — Carregamento, contagem regressiva e execução (pista, letra, `micMeter`, sequência)
  * `[ ] T3.3.2` — Menu de pausa e atalhos (`Espaço`, `Esc`, `F`, setas), Wake Lock, confirmação ao sair
  * `[ ] T3.3.3` — Avisos não-bloqueantes (vazamento, backend offline, dispositivo removido) e modo heurístico
* **Notas de Execução / Handoff:**
  * —

---

### `T3.4` — Tela de Resultado (`result.js`, gráfico temporal, confiança da nota)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/ui/screens/result.js`
  * `frontend/styles/result.css`
* **Detalhes de Implementação:**
  * Ao finalizar o instrumental, calcula o resumo no `scoringEngine`, gera o `id` da entrada com `crypto.randomUUID()` (o mesmo `id` será enviado ao `POST /api/history`, `CONTRACTS.md` §9.1), mantém a entrada na store (a gravação no backend entra na Fase 4) e navega para `#/resultado/:entryId`. A tela lê a entrada da store; se não estiver lá (recarregamento), usa `GET /api/history/:id` (disponível a partir da `T4.3`). O gráfico usa `details.segments`.
  * Exibe:
    * Nota final em destaque (`0.0` a `10.0`) e dificuldade jogada.
    * Gráfico simples (SVG/Canvas) de desempenho por trecho ao longo da música.
    * Estatísticas: melhor sequência (*streak*), % de cobertura vocal e comparação com recorde pessoal naquela música.
    * **Aviso de Confiança (`ARCHITECTURE.md` Seção 9.6):** Quando a compatibilidade da música for `regular`, `low` ou `incompatible` (ou modo heurístico), exibir aviso claro: *"Esta nota pode ser menos precisa porque o gabarito desta música tem baixa confiabilidade."*
    * Botões: *Cantar Novamente*, *Escolher Outra Música*, *Ver Histórico*.
* **Critérios de Aceitação:**
  * Fim da música transiciona automaticamente para a tela de resultado exibindo nota, gráfico de trechos e botões de ação.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T3.5` — Bateria de testes de pontuação (auto-teste, ruído, oitava, silêncio, latência)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `scripts/test-scoring.js` (testes unitários/simulação com Node test runner `node --test`)
* **Detalhes de Implementação:**
  * Implementar suíte automatizada cobrindo os 5 cenários obrigatórios da Seção 14.2 do `ARCHITECTURE.md`: Usar `pitch_map` **sintético gerado dentro do teste** (sem depender de música real nem do worker). Esta task depende só da `T3.1` e deve ser executada logo depois dela.
    1. **Gabarito contra si mesmo:** alimentar o `scoringEngine` com os próprios valores de `pitch_map.json` deve resultar em nota $\approx 10.0$.
    2. **Degradação gradual com ruído:** adicionar jitter de semitons crescente e perda parcial de frames; verificar queda suave e proporcional da nota.
    3. **Invariância de oitava:** deslocar todas as notas do usuário em $+12$ e $-12$ semitons; a nota final deve permanecer idêntica.
    4. **Silêncio total:** entrada sem voz durante toda a música deve resultar em nota `0.0`.
    5. **Compensação de latência:** atrasar os frames do usuário em $+200\text{ ms}$ e configurar `latencyOffsetMs = 200`; a nota original deve ser restaurada.
* **Critérios de Aceitação:**
  * `node --test scripts/test-scoring.js` passa 100% dos casos de teste.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —