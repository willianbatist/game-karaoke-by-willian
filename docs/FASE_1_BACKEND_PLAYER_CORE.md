# Fase 1 — Backend Core e Player Sincronizado

> Status das tasks: **somente neste arquivo** (fonte única). Painel de handoff e regras: `docs/tasks/TASKS.md`. Formatos: `docs/CONTRACTS.md`.

**Referências:** `ARCHITECTURE.md` (Seções 5.1, 6.A.1, 6.B, 6.C, 8.2, 12.1, 13.1, 13.2, 13.5, 13.6) e `FRONTEND_ARCHITECTURE.md` (Seções 2, 5.1, 6, 7, 8.2, 9). Formatos de rotas, eventos e arquivos: `docs/CONTRACTS.md` §1, §4, §5.
**Objetivo:** Implementar o servidor orquestrador em Node.js (fila de jobs, cache FLAC, letras LRCLIB) e o núcleo do frontend com `AudioContext` como relógio mestre, sincronização de letras `.lrc` e player do YouTube escravo e mudo.

---

### `T1.1` — Servidor HTTP Node (`127.0.0.1`), estáticos, `GET /api/config` e guardas de segurança
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `backend/server.js`
  * `backend/utils/security.js`
  * `backend/utils/configLoader.js`
  * `backend/utils/errors.js`
  * `backend/routes/config.js`
  * `scripts/test-security.js`
* **Detalhes de Implementação:**
  * Usar **Express** (decisão fixada nesta revisão; adicionar a dependência em `package.json`). Não habilitar CORS: frontend e API são da mesma origem.
  * **Segurança Local (Seção 13.5 e `FRONTEND_ARCHITECTURE.md` 2 & 6.3):**
    * Fazer bind **estritamente** em `127.0.0.1` (nunca `0.0.0.0`).
    * Servir `frontend/` como arquivos estáticos na mesma origem da API (`/`, `/src/*`, `/styles/*`, `/vendor/*`, `/i18n/*`).
    * **Não** definir cabeçalho `Referrer-Policy: no-referrer` (o embed do YouTube exige referrer válido de `localhost`).
    * `validateVideoId(id)`: regex estrita `/^[A-Za-z0-9_-]{11}$/`. Rejeitar com HTTP `400` qualquer entrada inválida.
    * `safeResolveCachePath(cacheRoot, videoId, filename)`: valida `videoId`, resolve caminho absoluto com `path.resolve` e garante que inicia com `cacheRoot + path.sep` (bloqueio de *path traversal*).
  * `errors.js`: helper do formato de erro de `CONTRACTS.md` §1 (`{ error: { code, message } }`), usado por todas as rotas.
  * `GET /api/config`: devolve `{ audio, tolerances, scoring }` lidos de `config/default.json` (`CONTRACTS.md` §5). O frontend não lê `config/` do disco.
  * Testes (`node --test scripts/test-security.js`): `validateVideoId` e `safeResolveCachePath` com entradas válidas e com tentativas de `../`.
* **Critérios de Aceitação:**
  * Servidor sobe em `http://127.0.0.1:3000`, entrega `frontend/index.html` e bloqueia tentativas de `../` nas rotas de arquivos. `scripts/test-security.js` passa; `GET /api/config` retorna os blocos esperados.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T1.2` — `ProcessSupervisor`, `CacheManager` (FLAC/LRU), `JobQueue` (SSE) e worker de teste
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `backend/services/processSupervisor.js`
  * `backend/services/cacheManager.js`
  * `backend/services/jobQueue.js`
  * `scripts/fake-worker.js`
  * `scripts/test-jobqueue.js`
* **Detalhes de Implementação:**
  * `processSupervisor.js`:
    * Executa o Python do `venv` com `child_process.spawn` e **array de argumentos** (nunca string em shell). O comando base (`command` + `args`) é **injetável**: em produção é o Python de `worker/.venv` (caminho via `scripts/lib/venvPaths.js`); nos testes é `node scripts/fake-worker.js`.
    * Faz parse linha a linha (`readline`) do `stdout` como JSON Lines, emitindo eventos tipados (`progress`, `step_done`, `warning`, `error`, `done`).
    * Implementa timeout configurável por etapa (`step_timeout_seconds`) e cancelamento limpo (`SIGTERM` no Unix / `taskkill /pid /t /f` no Windows).
  * `cacheManager.js`:
    * Lê, valida e atualiza `backend/cache/<videoId>/manifest.json` (checagem de `schema_version` e existência dos arquivos declarados).
    * **Política LRU (Seção 13.6):** Calcula tamanho total de `backend/cache/`; ao ultrapassar `max_size_gb`, remove as pastas com `user.last_played` (ou `mtime`) mais antigo, desde que não haja job ativo para elas.
    * Reidrata músicas já prontas ao iniciar o servidor. Respeita a divisão de campos do manifest (`CONTRACTS.md` §4.2): nunca grava o manifest de um `videoId` com job ativo; escritas atômicas (`.tmp` + `rename`). Um manifest `ready` sem `compatibility`/`lyrics`/`user` é reenviado ao pós-processamento do job.
  * `jobQueue.js`:
    * Fila FIFO com **concorrência = 1** (Seção 13.2).
    * Estados do job: `queued` $\to$ `running` (com `step` e `percent`) $\to$ `ready | failed | canceled`.
    * Gerencia clientes inscritos via Server-Sent Events (SSE) por `jobId`, enviando histórico recente de eventos ao conectar e heartbeat periódico. Formato das mensagens: `CONTRACTS.md` §5.1 (eventos do worker + evento `state`; heartbeat `: ping` a cada `server.sse_heartbeat_seconds`).
    * **Pós-processamento (`onJobDone`):** ao receber `done` do worker, executa, em ordem, os hooks registrados (`CONTRACTS.md` §4.2, item 3) e só então marca o job `ready`. Nesta task o hook mescla o resumo da letra e inicializa `manifest.user`; a `T4.2` registra o hook de compatibilidade.
  * `scripts/fake-worker.js`: worker de mentira (Node) que obedece ao contrato (`job.json` de entrada, eventos JSON Lines, códigos de saída, artefatos mínimos válidos, honra `SIGTERM`), com modos de falha selecionáveis por variável de ambiente. Permite desenvolver e testar fila/SSE/cancelamento **sem Python, GPU nem modelos**.
* **Critérios de Aceitação:**
  * Dois `prepare` simultâneos para vídeos distintos enfileiram o segundo até o primeiro concluir; cancelamento interrompe o processo Python e marca o job como `canceled`. `node --test scripts/test-jobqueue.js` cobre fila FIFO, cancelamento, timeout e retomada usando o `fake-worker`.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T1.3` — `LyricsService` (LRCLIB + normalização) e rotas REST de preparo/cache
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `backend/services/lyricsService.js`
  * `backend/routes/prepare.js`
  * `backend/routes/jobs.js`
  * `backend/routes/songs.js`
  * `backend/routes/health.js`
  * `scripts/test-lyrics.js`
* **Detalhes de Implementação:**
  * `lyricsService.js` (Seção 6.A.1):
    * Normaliza títulos do YouTube removendo termos entre `()` e `[]` e sufixos como `"official video"`, `"clipe oficial"`, `"lyrics"`, `"HD"`, `"4K"`, mas preservando marcadores de versão (`live`, `ao vivo`, `acoustic`, `acústico`, `remix`) para uso na compatibilidade.
    * Consulta API pública do LRCLIB (`https://lrclib.net/api/search`) por `track_name` + `artist_name` e, como fallback, por `q` livre.
    * Seleciona o candidato com **menor diferença absoluta de duração** em relação ao vídeo do YouTube; salva todos os candidatos + o selecionado em `backend/cache/<videoId>/lyrics.json` (formato de `CONTRACTS.md` §4.4). **Não grava `manifest.json`**: o resumo é mesclado no manifest pelo pós-processamento do job (`CONTRACTS.md` §4.2).
  * Rotas REST (Seção 13.1):
    * `POST /api/prepare` (`{ videoId, title?, channel?, duration? }`): retorna imediato se `cache hit` (`status: "ready"`), ou cria/retorna o job existente na fila. Dispara a busca de letra em paralelo, usando os metadados recebidos (se ausentes, obtém com `yt-dlp --dump-json --no-playlist`). Formatos de resposta: `CONTRACTS.md` §5.
    * `GET /api/jobs/:id/events`: stream SSE de progresso.
    * `GET /api/jobs/:id`: estado atual do job (usado pelo frontend para retomar após queda de conexão, `FRONTEND_ARCHITECTURE.md` 8.3).
    * `POST /api/jobs/:id/cancel`: cancela job.
    * `GET /api/songs/:id`: retorna `manifest.json` + conteúdo de `lyrics.json`.
    * `GET /api/songs/:id/files/:name`: entrega `instrumental.flac`, `vocals.flac` ou `pitch_map.json` com suporte a `Range` / `Content-Type` adequado.
    * `PATCH /api/songs/:id`: persiste `lyrics.offset_ms`, a seleção manual de outro candidato de letra (`lyrics.selected_id`) e `user.latency_offsets_ms` (corpo em `CONTRACTS.md` §5). Só aceita música `ready`.
    * `GET /api/health`: diagnóstico do `doctor` + versão do `yt-dlp` (formato em `CONTRACTS.md` §2.4), reutilizando a função exportada por `scripts/doctor.js`.
* **Critérios de Aceitação:**
  * Fluxo via `curl`/Postman: `POST /api/prepare` processa um vídeo, transmite eventos via SSE e disponibiliza os arquivos via `GET /api/songs/:id/files/*`. `node --test scripts/test-lyrics.js` cobre normalização de títulos e escolha do candidato por duração (com respostas do LRCLIB simuladas).
* **Subtarefas (pré-definidas; atualizar o status de cada uma):**
  * `[ ] T1.3.1` — `lyricsService.js` + `scripts/test-lyrics.js`
  * `[ ] T1.3.2` — `routes/prepare.js` e `routes/jobs.js` (inclui SSE e `GET /api/jobs/:id`)
  * `[ ] T1.3.3` — `routes/songs.js` (manifest + letra, arquivos com `Range`, `PATCH`)
  * `[ ] T1.3.4` — `routes/health.js`
* **Notas de Execução / Handoff:**
  * —

---

### `T1.4` — Esqueleto do Frontend sem build (Router, Store, API/SSE, Temas, i18n, banner e confirmação)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/index.html`
  * `frontend/styles/tokens.css`
  * `frontend/styles/base.css`
  * `frontend/i18n/pt-BR.json`
  * `frontend/src/app.js`
  * `frontend/src/router.js`
  * `frontend/src/store.js`
  * `frontend/src/api.js`
  * `frontend/src/ui/components/banner.js`
  * `frontend/src/ui/dialogs/confirm.js`
* **Detalhes de Implementação:**
  * **Zero etapa de build (`FRONTEND_ARCHITECTURE.md` Seção 2):** ES Modules nativos (`<script type="module" src="./src/app.js">`).
  * `tokens.css`: variáveis CSS para tema escuro (padrão ideal para karaokê) e tema claro via `@media (prefers-color-scheme: light)` e atributo `[data-theme]`.
  * `i18n/pt-BR.json`: dicionário centralizado de strings da UI + helper `t(key, params)`.
  * `router.js`: roteador por hash suportando todas as rotas mapeadas na Seção 5.1 (`#/`, `#/busca`, `#/preparo/:videoId`, `#/pre-jogo/:videoId`, `#/jogo/:videoId`, `#/resultado/:entryId`, `#/biblioteca`, `#/historico`, `#/configuracoes`).
  * `store.js`: store reativa (`getState`, `setState`, `subscribe`) contendo `player`, `mode`, `song`, `job`, `audioSettings`, `session`, `ui`, `connection`.
  * `api.js`: cliente HTTP com tratamento de erro padronizado, reconexão automática de SSE e monitor de saúde do backend (`/api/health`). Carrega `GET /api/config` na inicialização e guarda o resultado na store (`config`), de onde os demais módulos leem tolerâncias e parâmetros de áudio.
  * `banner.js`: banner persistente de aviso, usado para "Servidor local não encontrado" quando o monitor de saúde detecta o backend fora do ar (`FRONTEND_ARCHITECTURE.md` seção 10). `confirm.js`: diálogo de confirmação reutilizável (sair da partida, apagar dados).
  * Convenção válida desde esta fase: todo texto dinâmico (nomes, títulos, letras) entra no DOM por `textContent` ou criação de nós; nunca por `innerHTML`.
* **Critérios de Aceitação:**
  * Navegação por hash funcional sem recarregar a página; alternância de tema e leitura de strings via `pt-BR.json` operacionais; derrubar o backend exibe o banner persistente e religá-lo o remove.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T1.5` — `AudioEngine` (relógio mestre `AudioContext`, stems, `offset_seek`)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/audio/audioEngine.js`
* **Detalhes de Implementação:**
  * **Princípio Arquitetural 1 e Seção 6.C:** O `AudioContext` é a fonte única de verdade do tempo.
  * Carrega `instrumental.flac` e `vocals.flac` em paralelo (`fetch` + `audioCtx.decodeAudioData`), armazenando os `AudioBuffer`s decodificados em memória (e liberando-os ao sair da partida).
  * Cria dois `AudioBufferSourceNode`s conectados a `GainNode`s independentes (`instrumentalGain` e `guideVocalGain`, com slider `0.0` a `1.0`), iniciados no mesmo timestamp agendado `t_inicio = audioCtx.currentTime + 0.05`.
  * **Cálculo do Relógio Mestre:** `getCurrentTime() = audioCtx.currentTime - t_inicio + offset_seek`.
  * **Pausa / Retomada:** `audioCtx.suspend()` e `audioCtx.resume()`.
  * **Consolidação de Posição (Seção 8.2):** Implementar método `consolidateAndRebuildRouting()` que salva `offset_seek = getCurrentTime()`, para e descarta os `AudioBufferSourceNode`s antigos (que são descartáveis na Web Audio API), reconecta ao destino de saída atualizado e recria/inicia novos sources a partir de `offset_seek` com novo `t_inicio` reaproveitando os `AudioBuffer`s decodificados.
  * Emite evento `ended` quando o tempo atingir a duração do `instrumental`.
  * **Interface exigida pelos demais módulos** (`CONTRACTS.md` §6): `getContext()` (o microfone usa o mesmo `AudioContext`), `contextTimeToSongTime(ctxTime)` (= `ctxTime - t_inicio + offset_seek`, sempre com os valores vigentes), `pause()`, `resume()`, `consolidateAndRebuildRouting()` e o evento `ended`.
* **Critérios de Aceitação:**
  * Instrumental e voz guia tocam em sincronia perfeita de amostra; alterar volume da voz guia não afeta o instrumental; consolidar posição retoma exatamente do mesmo milissegundo.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T1.6` — `LyricSync` (`.lrc` + fallbacks) e `YouTubePlayer` (escravo mudo)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/game/lyricSync.js`
  * `frontend/src/video/youtubePlayer.js`
  * `scripts/test-lyricsync.js`
* **Detalhes de Implementação:**
  * `lyricSync.js`: Módulo puro (sem DOM), para ser testável com `node --test scripts/test-lyricsync.js` (parser, múltiplas tags, ordenação, offset, fallbacks).
    * Parser de formato `.lrc` (`[mm:ss.xx] texto`), ordenando timestamps e suportando múltiplas tags por linha.
    * Método `update(masterTimeSeconds, offsetMs)`: determina linha atual, linha anterior e próximas linhas aplicando `effectiveTime = masterTimeSeconds + (offsetMs / 1000)`.
    * **Fallbacks (Seção 11):** Se houver apenas `plainLyrics`, calcula rolagem proporcional baseada na duração total da música e permite rolagem manual; se não houver letra alguma, informa estado `"none"` sem erro.
  * `youtubePlayer.js` (Seção 6.C e `FRONTEND_ARCHITECTURE.md` Seção 6):
    * Carrega YouTube IFrame Player API de forma assíncrona.
    * Configura embed **mudo** (`mute()`), sem controles intrusivos, usando domínio configurável (`youtube.com` padrão ou `youtube-nocookie.com`).
    * Loop de sincronização (ex.: a cada `500 ms`): lê `audioEngine.getCurrentTime()` e `player.getCurrentTime()`; se $|\Delta| > 0.30\text{ s}$ (ou parâmetro `youtube_drift_ms`), executa `player.seekTo(masterTime, true)`.
    * Espelha estados `play`/`pause` do `AudioEngine`.
    * **Resiliência:** Em caso de erro do player (`onError`: bloqueio de embed, restrição de idade, falha de rede) ou opção do usuário desligada, ativa imediatamente o estado de fallback visual (thumbnail desfocada em tela cheia) sem interromper o áudio. Nunca tentar bloquear anúncios.
* **Critérios de Aceitação:**
  * Letra sincroniza com o `AudioEngine` e responde instantaneamente a ajustes de `offset_ms`; vídeo do YouTube acompanha o áudio mudo e cai graciosamente para thumbnail se falhar.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T1.7` — Tela de Jogo v1 (integração básica de áudio, letra e vídeo)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/ui/screens/game.js`
  * `frontend/src/ui/components/lyricsDisplay.js`
  * `frontend/styles/game.css`
* **Detalhes de Implementação:**
  * Construir uma primeira versão funcional da rota `#/jogo/:videoId` para validar toda a Fase 1 ponta a ponta.
  * Exibir: palco com vídeo mudo (ou fundo alternativo), overlay escuro para contraste, `lyricsDisplay` com linha atual em destaque, controles básicos (Play/Pause, slider de volume da voz guia `0–100%`, ajuste rápido de `offset_ms` da letra com botões `-100ms`/`+100ms` persistidos via `PATCH /api/songs/:id`).
* **Critérios de Aceitação:**
  * Abrir `http://127.0.0.1:3000/#/jogo/<videoId_em_cache>` reproduz uma música preparada pelo worker real (T0.4) com voz guia ajustável, letra sincronizada e vídeo escravo.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —