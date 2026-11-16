# Contratos Concretos — Karaokê Local (`localhost`)

**Documentos pai:** `docs/ARCHITECTURE.md` (v2.2) e `docs/FRONTEND_ARCHITECTURE.md` (v1.0).
**Função deste documento:** fixar os formatos (payloads, eventos, arquivos, chaves) que os dois documentos de arquitetura descrevem apenas em resumo, para que backend, worker e frontend possam ser implementados por agentes diferentes sem divergir.

## 0. Como ler este documento

* Em conflito, **os documentos de arquitetura prevalecem** sobre este.
* Cada item vem marcado:
  * **`[ARQ §x]`** — já definido na arquitetura; aqui apenas consolidado.
  * **`[DECISÃO]`** — a arquitetura não especifica; este documento fixa o formato **mais simples possível** para preencher a lacuna. Se um agente encontrar motivo técnico concreto para mudar, deve registrar em `Notas de Execução` e sinalizar ao responsável, não contornar em silêncio.
* **Valores numéricos marcados `(inicial)` são pontos de partida** a calibrar no spike (T0.6). Devem ficar em `config/`, nunca no código.
* O que **não** está aqui nem na arquitetura **não deve ser inventado**: escolha a opção mais simples, registre a dúvida em `Notas de Execução` e siga.

---

## 1. Convenções HTTP

* `[DECISÃO]` Corpo e respostas em JSON (`application/json`), exceto SSE, arquivos do cache e exportação.
* `[DECISÃO]` Formato único de erro, produzido por helper do backend e interpretado por `api.js`:
  ```json
  { "error": { "code": "INVALID_VIDEO_ID", "message": "mensagem curta em pt-BR" } }
  ```
  Códigos HTTP: `400` entrada inválida · `404` não encontrado · `409` conflito (ex.: remover música com job ativo) · `500` erro interno · `503` dependência indisponível.
* `[ARQ 13.5]` `videoId` validado por `/^[A-Za-z0-9_-]{11}$/` antes de qualquer uso.
* `[ARQ FRONT 4.3]` Datas em ISO 8601 com offset local (`2026-11-14T20:31:05-03:00`).

---

## 2. Worker Python ⇄ Node

### 2.1 `job.json` `[ARQ 5.3]`
```json
{
  "contract_version": 1,
  "video_id": "abc123XYZ_0",
  "workdir": "/caminho/cache/abc123XYZ_0",
  "steps": ["download", "separate", "pitch", "analyze", "package"],
  "options": {
    "separation_model": "<de config>",
    "device": "auto",
    "pitch_extractor": "pyin",
    "pitch_hop_seconds": 0.02,
    "output_audio_format": "flac"
  }
}
```
Os valores de `options` vêm de `config/default.json` (`worker.*`, `cache.audio_format`). Nomes das etapas: `download`, `separate`, `pitch`, `analyze`, `package`.

### 2.2 Eventos em `stdout` (JSON Lines) `[ARQ 5.3]`
```json
{"event":"progress","step":"separate","percent":42,"message":"Separando voz"}
{"event":"step_done","step":"download","artifacts":["source.m4a"],"seconds":8.2}
{"event":"warning","code":"LOW_VOCAL_ENERGY","message":"..."}
{"event":"error","code":"DOWNLOAD_FAILED","message":"...","retryable":true}
{"event":"done","manifest":"manifest.json"}
```
* `[DECISÃO]` O evento `progress` da etapa `separate` pode trazer o campo opcional `"device":"cuda|mps|directml|rocm|cpu"` (o acelerador realmente usado), para a UI exibir "GPU" ou "CPU" enquanto o job roda. O mesmo valor é gravado em `manifest.pipeline.device_used`.
* Códigos de saída `[ARQ 5.3]`: `0` sucesso · `10` recuperável · `20` dependência ausente · `30` dados inválidos · `130` cancelado.

### 2.3 Responsabilidades do worker
* Nunca escreve fora de `workdir` `[ARQ 5.3]`.
* Escreve `manifest.json` apenas nos campos listados em §4.2 (coluna "Dono: worker").

### 2.4 Saída de `doctor --json` `[DECISÃO]` (campos listados na T0.3)
```json
{
  "contract_version": 1,
  "python_version": "3.11.9",
  "accelerator_profile_installed": "cuda",
  "accelerator_detected": "cuda",
  "accelerator_test": { "ok": true, "device": "cuda", "detail": "" },
  "ffmpeg": { "ok": true, "version": "..." },
  "yt_dlp": { "ok": true, "version": "..." },
  "models": [{ "name": "...", "downloaded": true }],
  "disk_free_gb": 123.4
}
```
`scripts/doctor.js` agrega isso com as checagens do lado Node (versão do Node, `venv`, runtime JS do `yt-dlp` se exigido) em:
```json
{ "ok": true,
  "checks": [ { "id": "node", "label": "Node.js", "status": "ok|warn|fail", "detail": "v20.11", "fix": "instrução acionável (opcional)" } ] }
```
`GET /api/health` devolve `{ "doctor": <esse objeto>, "ytdlp_version": "..." }`.

---

## 3. Métricas do worker (etapa `analyze`) `[DECISÃO]`

A arquitetura (10.2) diz o que cada métrica significa, mas não como calculá-la. Definições operacionais **iniciais**, a validar no spike (T0.6). Todas normalizadas em `0.0–1.0`. "Voz confiável" = frame com `midi != null` e `conf >= audio.pitch_conf_threshold`.

| Métrica | Cálculo inicial | Sentido |
| :--- | :--- | :--- |
| `voiced_ratio` | frames com voz confiável ÷ total de frames | maior = melhor |
| `mean_confidence` | média de `conf` nos frames com `midi != null` | maior = melhor |
| `vocal_energy_ratio` | energia (média dos quadrados) do stem de voz ÷ energia do áudio original, limitado a `[0,1]` | maior = mais voz; ~0 = faixa já instrumental |
| `bleed_estimate` | energia média do stem de voz nos frames **sem** voz detectada ÷ energia média nos frames com voz, limitado a `[0,1]` | **maior = pior** |
| `backing_vocals_estimate` | frames com energia vocal acima do piso mas sem F0 confiável ÷ frames com energia vocal acima do piso (proxy de vozes simultâneas) | **maior = pior** |
| `pitch_stability` | `1 − (saltos ≥ analysis.jump_semitones entre frames consecutivos com voz ÷ pares de frames consecutivos com voz)` | maior = melhor |

* `lyrics_sync_quality` **não** é calculada pelo worker; é calculada pelo Node (§8.2).
* Se uma métrica não puder ser calculada, gravar `0.0` e emitir `warning`; nunca omitir a chave.
* `vocal_energy_ratio < analysis.instrumental_vocal_energy_ratio` ⇒ `analyze` reescreve `pitch_map.json` com `"mode": "heuristic"` (arquitetura 11) e emite `warning` `LOW_VOCAL_ENERGY`.

---

## 4. Arquivos do cache e donos de cada campo

### 4.1 Estrutura `[ARQ 12]`
```text
backend/cache/<videoId>/
  manifest.json  instrumental.flac  vocals.flac  pitch_map.json  lyrics.json
```

### 4.2 `manifest.json` `[ARQ 12.1]` + donos `[DECISÃO]`

| Campo | Dono |
| :--- | :--- |
| `schema_version`, `video_id`, `status`, `steps_done`, `source`, `pipeline`, `files`, `metrics` | **worker** (Python) |
| `compatibility`, `lyrics`, `user` | **Node** |

Regras para evitar escrita concorrente:
1. O Node **não grava `manifest.json` enquanto houver job ativo** para aquele `videoId`.
2. Durante o job, a busca de letra grava **somente `lyrics.json`** (§4.4).
3. Quando o worker emite `done`, o `jobQueue` executa o **pós-processamento** (hooks `onJobDone`, ver T1.2): mescla o resumo da letra em `manifest.lyrics`, inicializa `manifest.user` (`{ "latency_offsets_ms": {}, "last_played": null }`) e, após o T4.2, grava `manifest.compatibility`. Só então o job vai a `ready` e o evento `state: ready` é enviado.
4. O pós-processamento é **idempotente**: na reidratação do servidor, um manifest com `status: "ready"` sem `compatibility`/`lyrics`/`user` é reprocessado.
5. Escritas do Node no manifest são atômicas (arquivo `.tmp` + `rename`).
6. Estado do job (`queued/running/failed/canceled`) vive em memória; diretório sem `status: "ready"` não é música pronta.

Blocos do Node:
```json
"lyrics": { "source": "lrclib", "type": "synced|plain|none", "selected_id": 123, "offset_ms": 0, "sync_quality": 0.0 },
"compatibility": { "level": "good", "score": 0.0, "reasons": ["..."], "provisional": false },
"user": { "latency_offsets_ms": { "<inputDeviceId>|<outputDeviceId>": 120 }, "last_played": "ISO|null" }
```
`user.last_played` é atualizado pelo backend quando o frontend baixa os arquivos para jogar (`GET /api/songs/:id/files/instrumental.flac`) — mesma lógica de LRU.

### 4.3 `pitch_map.json` `[ARQ 9.1]`
```json
{ "schema_version": 1, "extractor": "pyin", "hop": 0.02, "t0": 0.0,
  "midi": [null, 64.1], "conf": [0.0, 0.95], "mode": "reference" }
```
`mode` é `"reference"` ou `"heuristic"`.

### 4.4 `lyrics.json` `[DECISÃO]`
```json
{
  "schema_version": 1,
  "query": { "track_name": "...", "artist_name": "..." },
  "candidates": [ { "id": 123, "trackName": "...", "artistName": "...", "duration": 241, "plainLyrics": "...", "syncedLyrics": "[00:12.30] ..." } ],
  "selected_id": 123
}
```
`candidates` guarda os campos do LRCLIB **como recebidos** (sem renomear). Sem resultado: `candidates: []`, `selected_id: null`. O texto de `syncedLyrics` é o formato `.lrc` `[mm:ss.xx] texto`.

---

## 5. Rotas REST (somente `127.0.0.1`) 

Lista de rotas `[ARQ 13.1 e FRONT 13]`; formatos `[DECISÃO]` salvo indicação.

| Rota | Corpo / Query | Resposta `200` |
| :--- | :--- | :--- |
| `GET /api/config` | — | `{ "audio": {...}, "tolerances": {...}, "scoring": {...} }` (blocos de `config/default.json`) |
| `GET /api/search?q=` | `q` não vazio, senão `400` | `{ "results": [ { "videoId", "title", "channel", "duration", "thumbnail", "hasSyncedLyrics" } ] }` — **sem** compatibilidade |
| `POST /api/prepare` | `{ "videoId", "title"?, "channel"?, "duration"? }` | cache hit: `{ "status": "ready", "videoId" }` · senão: `{ "status": "queued\|running", "jobId", "videoId", "compatibility": <pré-análise §8.3 ou null> }` |
| `GET /api/jobs/:id` | — | `{ "id", "videoId", "state", "step", "percent", "device"? }` |
| `GET /api/jobs/:id/events` | — | SSE (§5.1) |
| `POST /api/jobs/:id/cancel` | — | `{ "state": "canceled" }` |
| `GET /api/songs/:id` | — | `{ "manifest": {...}, "lyrics": <lyrics.json ou null> }` |
| `GET /api/songs/:id/files/:name` | `name` ∈ `instrumental.flac`, `vocals.flac`, `pitch_map.json` | arquivo, com `Range` |
| `PATCH /api/songs/:id` | `{ "lyrics"?: { "offset_ms"?, "selected_id"? }, "user"?: { "latency_offsets_ms"?: { "<in>\|<out>": ms } } }` | manifest atualizado |
| `GET /api/library` | — | `{ "songs": [ { "videoId", "title", "channel", "duration", "compatibility", "size_bytes", "last_played" } ] }` (só `status: ready`, ordenada por `last_played`/criação) |
| `DELETE /api/songs/:id` | — | `{ "deleted": true }`; `409` se houver job ativo |
| `GET /api/health` | — | §2.4 |

* `POST /api/prepare` — metadados opcionais vêm do resultado de busca escolhido. Se ausentes (ex.: recarregar `#/preparo/:videoId`), o backend os obtém com `yt-dlp --dump-json --no-playlist` do próprio vídeo. Sem metadados utilizáveis, `compatibility` é `null`.
* `PATCH /api/songs/:id` com `lyrics.selected_id` novo recalcula `lyrics.sync_quality` e `compatibility` (no-op até existir o T4.2). A música precisa estar `ready` (senão `409`).
* Duas chamadas `POST /api/prepare` para o mesmo `videoId` devolvem o **mesmo `jobId`** `[ARQ T1.3]`.

### 5.1 SSE `GET /api/jobs/:id/events`
* `Content-Type: text/event-stream`. Cada mensagem: `data: <json>\n\n`, e o JSON sempre tem o campo `event`.
* Ao conectar, o servidor reenvia os eventos recentes do job, depois transmite os novos `[ARQ T1.2]`.
* Tipos: os eventos do worker (§2.2) mais `{"event":"state","state":"queued|running|ready|failed|canceled","step":"...","percent":0,"position":1}` (`position` só em `queued`).
* Heartbeat: comentário `: ping` a cada `server.sse_heartbeat_seconds`.
* O fluxo termina após `state: ready|failed|canceled`.

### 5.2 Jogadores e histórico `[ARQ FRONT 13]` + formatos `[DECISÃO]`

| Rota | Resposta |
| :--- | :--- |
| `GET /api/players` | `{ "players": [ { "id", "name", "created_at" } ] }` |
| `POST /api/players` `{ name }` | `201` jogador criado; nome duplicado → `409` |
| `PATCH /api/players/:id` `{ name }` | jogador atualizado |
| `DELETE /api/players/:id?history=keep\|delete` | `{ "deleted": true }`; `keep` ⇒ entradas ficam com `player_id: null` e `player_name` original |
| `GET /api/history?player_id=&video_id=&from=&to=&limit=` | `{ "entries": [ <entrada> ] }` (mais recentes primeiro) |
| `GET /api/history/:id` | `<entrada>` ou `404` |
| `POST /api/history` `<entrada>` | `201` entrada gravada; se o `id` **já existir**, `200` com a entrada existente, sem duplicar |
| `DELETE /api/history/:id` | `{ "deleted": true }` |
| `DELETE /api/history?player_id=` | apaga as entradas do jogador; **sem** `player_id` apaga tudo e exige `confirm=all` na query |
| `GET /api/history/rankings?video_id=` | `{ "video_id", "entries": [ { "player_id", "player_name", "best_score", "difficulty", "played_at" } ] }` — melhor nota por jogador, ordem decrescente |
| `GET /api/history/export?format=csv\|txt&player_id=&bom=1&sep=;\|,&decimal=comma\|dot` | arquivo com `Content-Disposition: attachment` |

---

## 6. Tempo e eventos internos do frontend `[DECISÃO]`

Necessário para que `AudioEngine`, captura do microfone e pontuação concordem sobre "que instante da música" cada frame representa.

* **O microfone usa o mesmo `AudioContext` do `AudioEngine`** (`audioEngine.getContext()`).
* `audioEngine.contextTimeToSongTime(ctxTime)` = `ctxTime - t_inicio + offset_seek`, sempre com o `t_inicio`/`offset_seek` vigentes.
* O `pitchWorklet` envia `{ samples, rms, contextTime }` em que `contextTime` aproxima o **fim** da janela de 2048 amostras.
* O `pitchDetector` emite um frame com `songTime` = `contextTimeToSongTime(contextTime) - (janela/2)/sampleRate`, isto é, o **centro** da janela. Formato do frame:
  ```js
  { songTime, midi /* número real ou null */, clarity, rms }
  ```
* Eventos via `EventTarget`/`CustomEvent`: `audioEngine` → `ended`; `audioDevices` → `devicelost` (`{ kind: 'input'|'output' }`); `pitchDetector` → `frame`, `speaker_bleed_detected`.

---

## 7. `scoringEngine` `[ARQ 9; interface DECISÃO]`

```js
const engine = createScoringEngine({
  pitchMap, difficulty,            // 'easy' | 'normal' | 'hard'
  tolerances, pitchConfThreshold,  // vindos de /api/config
  latencyOffsetMs, autoTranspose,  // autoTranspose: false por padrão
  heuristicConfig                  // config.scoring.heuristic
});
engine.pushFrame({ songTime, midi }); // -> { counted, points, hit: 'perfect'|'good'|'miss'|null }
engine.summary();
// -> { score,                      // 0.0–10.0, uma casa decimal
//      best_streak, coverage,      // coverage = frames cantados ÷ frames contados (0–1)
//      scoring_confidence,         // 'high' | 'low' ('low' no modo heurístico)
//      segments,                   // array de 0–1: acerto médio por trecho (nº de trechos fixo, ex. 24)
//      transposition_semitones }   // 0 se autoTranspose desligado
```
* Índice: `idx = Math.round((songTime - latencyOffsetMs/1000 - pitchMap.t0) / pitchMap.hop)`; `idx < 0` ou `idx >= midi.length` ⇒ frame ignorado.
* Regras de contagem, distância circular e tolerâncias: arquitetura 9.3–9.6 (sem alteração).
* `best_streak` = maior sequência de frames contados consecutivos com `hit` ≠ `miss`.
* **Modo heurístico (`pitchMap.mode === 'heuristic'`)** — a arquitetura (11) só define "presença vocal e estabilidade". Definição mínima inicial:
  * Frame "estável" = usuário com voz e `|midi − mediana dos últimos stability_window_frames| ≤ stability_tolerance_semitones` (distância circular).
  * `score = 10 · min(1, frames_estáveis / (full_score_coverage · total_de_frames_da_música))`.
  * `scoring_confidence = 'low'`.
  * Parâmetros em `config.scoring.heuristic` (§11).

---

## 8. Compatibilidade `[ARQ 10; fórmulas DECISÃO]`

Níveis: `excellent | good | regular | low | incompatible`.

### 8.1 `config/compatibility-weights.json` (estrutura; valores `(inicial)`)
```json
{
  "schema_version": 1,
  "weights": {
    "voiced_ratio": 0.15, "mean_confidence": 0.20, "vocal_energy_ratio": 0.10,
    "bleed_estimate": 0.15, "backing_vocals_estimate": 0.15,
    "pitch_stability": 0.10, "lyrics_sync_quality": 0.15
  },
  "thresholds": { "excellent": 0.80, "good": 0.65, "regular": 0.50, "low": 0.30 },
  "incompatible_rules": { "min_voiced_ratio": 0.05 },
  "reason_threshold": 0.4,
  "lyrics_sync_quality": { "best_delta_s": 2, "worst_delta_s": 15, "synced_best": 1.0, "synced_worst": 0.4, "plain": 0.3, "none": 0.0 },
  "pre_analysis": {
    "keyword_penalties": { "ao vivo": 0.15, "live": 0.15, "acústico": 0.10, "acoustic": 0.10, "remix": 0.20, "cover": 0.20, "karaoke": 0.40, "instrumental": 0.60, "mashup": 0.30, "playlist": 0.40, "loop": 0.30 },
    "duration_min_s": 45, "duration_max_s": 480, "duration_penalty": 0.30,
    "lyrics_missing_penalty": 0.15,
    "duration_mismatch": { "tolerance_s": 5, "penalty": 0.15 }
  }
}
```

### 8.2 Pós-análise (Fase 2) — `compatibilityService`
* `m'` = métrica normalizada com "maior = melhor": `m' = m` para `voiced_ratio`, `mean_confidence`, `vocal_energy_ratio`, `pitch_stability`, `lyrics_sync_quality`; `m' = 1 − m` para `bleed_estimate` e `backing_vocals_estimate`.
* `score = Σ(peso_i · m'_i) / Σ(peso_i)`.
* Nível: `score ≥ excellent` → `excellent`; `≥ good` → `good`; `≥ regular` → `regular`; `≥ low` → `low`; abaixo → `incompatible`.
* Regra de incompatibilidade: `voiced_ratio < min_voiced_ratio` **ou** `pitch_map.mode === 'heuristic'` ⇒ `incompatible`.
* `lyrics_sync_quality`: `none` → valor `none`; só `plainLyrics` → `plain`; sincronizada → `synced_best` se `|Δduração| ≤ best_delta_s`, caindo linearmente até `synced_worst` em `worst_delta_s`. Δduração = letra do candidato selecionado vs. `manifest.source.duration`.
* `reasons`: um texto pt-BR por métrica cujo `m' < reason_threshold`. Exemplos: backing → "Muitas vozes de apoio"; letra → "Letra sem sincronização"; `incompatible` por heurístico → "Faixa aparentemente já instrumental".

### 8.3 Pré-análise (Fase 1)
* Entradas: título, canal, duração (do vídeo) e o candidato de letra selecionado.
* `score_pre = max(0, 1 − Σ penalidades)`: palavra-chave de `keyword_penalties` presente (palavra inteira, sem diferenciar maiúsculas/acentos) no título ou canal; duração fora de `[duration_min_s, duration_max_s]`; sem letra; |Δduração| vídeo×letra acima de `tolerance_s`.
* Nível pelos mesmos `thresholds` (a pré-análise nunca devolve `incompatible`; o piso é `low`).
* Saída: `{ "level", "score", "reasons": ["Versão ao vivo: a letra pode estar desalinhada"], "provisional": true }`.
* Executa só com metadados e LRCLIB; **< 50 ms** sobre dados já em memória.

---

## 9. Jogadores e histórico `[ARQ FRONT 4]`

### 9.1 Entrada de histórico
Formato exato de `FRONTEND_ARCHITECTURE.md` 4.3. Regras de validação `[DECISÃO]`:

| Campo | Regra |
| :--- | :--- |
| `id` | UUID v4 **gerado no cliente** (`crypto.randomUUID()`), obrigatório |
| `player_id` | string ou `null`; `player_name` obrigatório, 1–30 caracteres |
| `mode` | `"standard"` |
| `session_id` | `null` |
| `video_id` | regex do §1 |
| `song_title`, `artist` | strings até 200 caracteres (`artist` pode ser vazio) |
| `played_at` | ISO 8601 |
| `duration_s` | número ≥ 0 |
| `score` | número entre `0.0` e `10.0` |
| `completed` | booleano |
| `difficulty` | `easy` \| `normal` \| `hard` |
| `compatibility_level` | um dos cinco níveis |
| `scoring_confidence` | `high` \| `low` |
| `mic_quality` | `good` \| `acceptable` \| `poor` \| `null` (Bom/Aceitável/Fraco da calibração) |
| `assists` | `{ auto_transpose: boolean, guide_volume: 0–1 }` |
| `details` | `{ best_streak: int ≥ 0, coverage: 0–1, segments?: number[] }` (`segments` = array do §7, permite redesenhar o gráfico do resultado) |
| `scoring_version`, `app_version` | `scoring_version` inteiro (valor atual `1`); `app_version` string |

### 9.2 CSV `[ARQ FRONT 4.4]`
Colunas, nesta ordem: `data_hora;jogador;modo;musica;artista;nota;dificuldade;compatibilidade;concluida`.
* Padrão pt-BR: separador `;`, decimal vírgula (`8,7`), UTF-8; `bom=1` antepõe `\uFEFF`. `sep=,` e `decimal=dot` são a variante alternativa.
* Valores com separador, aspas ou quebra de linha seguem o escape padrão de CSV (campo entre aspas, aspas duplicadas).
* `dificuldade`: fácil / normal / difícil · `concluida`: sim / não.

### 9.3 TXT
Relatório legível, agrupado por jogador, uma linha por partida, por exemplo: `2026-11-14 20:31 | Evidências — Chitãozinho e Xororó | 8,7 | Normal | Compat.: Boa | concluída`.

### 9.4 Persistência `[ARQ FRONT 4.4]`
`backend/data/players.json` e `history.json`, cada um com `schema_version: 1`; `backups/` com os **5** últimos; fila única de gravação por arquivo; `.tmp` + `rename`; JSON corrompido → `*.corrupt-<timestamp>` e estrutura nova.

---

## 10. Chaves de `localStorage` (prefixo `karaoke.`, sufixo de versão)

| Chave | Conteúdo | Origem |
| :--- | :--- | :--- |
| `karaoke.audioDevices.v1` | `{ inputDeviceId, outputDeviceId }` | `[ARQ T2.2]` |
| `karaoke.pendingHistory.v1` | fila de entradas ainda não enviadas | `[ARQ T4.4]` |
| `karaoke.micProfiles.v1` | perfil de calibração por dispositivo de entrada (ganho, piso de ruído, veredito, extensão vocal) | `[DECISÃO]` |
| `karaoke.latency.v1` | `{ "<in>\|<out>": ms }` — padrão por par de dispositivos | `[DECISÃO]` |
| `karaoke.lastPlayer.v1` | id do último jogador (ou `"guest"`) | `[DECISÃO]` |
| `karaoke.prefs.v1` | preferências de jogo e aparência (ver T4.6) | `[DECISÃO]` |
| `karaoke.firstRunDone.v1` | booleano do assistente de primeiro uso | `[DECISÃO]` |

* Toda leitura/escrita em `try/catch`; ausência de dados nunca quebra a tela `[ARQ FRONT 8.1]`.
* **Latência efetiva** = `manifest.user.latency_offsets_ms["<in>|<out>"]` (ajuste por música) → senão `karaoke.latency.v1["<in>|<out>"]` → senão `0`. O slider em Configurações grava o padrão do par; o ajuste na pausa/pré-jogo grava o valor da música (`PATCH /api/songs/:id`).

---

## 11. Blocos de `config/default.json` além dos de `ARCHITECTURE.md` `[DECISÃO]`

```json
"server":   { "host": "127.0.0.1", "port": 3000, "sse_heartbeat_seconds": 15 },
"analysis": { "instrumental_vocal_energy_ratio": 0.05, "jump_semitones": 10 },
"search":   { "results": 12, "lyrics_timeout_ms": 1500 },
"scoring":  { "heuristic": { "stability_window_frames": 5, "stability_tolerance_semitones": 1.5, "full_score_coverage": 0.6 } }
```
Os demais blocos (`cache`, `worker`, `audio`, `tolerances`) são os da T0.1. Todos os valores numéricos são `(inicial)`.

---

## 12. Fora de escopo (não implementar)

Modo Campeonato (além do placeholder) · duetos · multiusuário em rede · SQLite · worker residente · roteamento de voz guia/instrumental para saídas distintas (`ARCHITECTURE.md` 8.4) · contas, autenticação ou qualquer hardening além do que a arquitetura descreve (o app é de uso pessoal em `localhost`) · empacotamento/instalador · telemetria.
