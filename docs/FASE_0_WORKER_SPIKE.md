# Fase 0 — Fundação, Setup Cross-Platform e Spike do Worker de IA

> Status das tasks: **somente neste arquivo** (fonte única). Painel de handoff e regras: `docs/tasks/TASKS.md`. Formatos: `docs/CONTRACTS.md`.

**Referências:** `ARCHITECTURE.md` (Seções 3, 5, 9.1, 10.2, 12, 13.3, 13.4, 14.1, 15) e `docs/CONTRACTS.md` (leia antes de implementar; define formatos de eventos, métricas e manifest).
**Objetivo:** Construir o alicerce do projeto, isolar o ambiente Python por acelerador de hardware, implementar o contrato Node $\leftrightarrow$ Python e validar a qualidade da separação vocal e extração de F0 em ~20 músicas reais antes de construir a interface.

---
### `T0.1` — Estrutura de diretórios, `config/*.json`, documentos em `docs/` e `README.md`
* **Status:** `[x] COMPLETA`
* **Arquivos:**
  * `package.json` (raiz, Node 20+, `"type": "module"`) com scripts `start` (sobe o backend), `doctor` (`node scripts/doctor.js`) e `test` (`node --test`)
  * `config/default.json`
  * `config/compatibility-weights.json`
  * `README.md`
  * `.gitignore` (`node_modules/`, `backend/cache/`, `backend/data/`, `worker/.venv/`, `__pycache__/`)
  * `docs/ARCHITECTURE.md`, `docs/FRONTEND_ARCHITECTURE.md`, `docs/CONTRACTS.md` (copiar os documentos fornecidos; `arquitetura-v2_1.md` vira `docs/ARCHITECTURE.md`)
  * Estrutura de pastas: `docs/`, `config/`, `backend/{routes,services,data,cache}`, `worker/{setup,karaoke_worker/steps,karaoke_worker/util}`, `frontend/{styles,vendor,i18n,src}`, `scripts/`
* **Detalhes de Implementação:**
  * Centralizar em `config/default.json` todos os parâmetros iniciais calibráveis (nunca espalhar constantes no código):
    * `server`: `{ "host": "127.0.0.1", "port": 3000 }`
    * `cache`: `{ "max_size_gb": 10, "audio_format": "flac" }`
    * `worker`: `{ "contract_version": 1, "separation_model": "<definido na T0.2>", "pitch_extractor": "pyin", "pitch_hop_seconds": 0.02, "step_timeout_seconds": 600 }`
    * `audio`: `{ "highpass_hz": 80, "lowpass_hz": 1200, "clarity_on": 0.85, "clarity_off": 0.70, "pitch_conf_threshold": 0.60, "hold_ms": 130, "median_window": 3, "youtube_drift_ms": 300, "youtube_embed_domain": "youtube.com" }`
    * `tolerances`: `{ "easy": { "full": 1.0, "half": 2.0 }, "normal": { "full": 0.8, "half": 1.8 }, "hard": { "full": 0.5, "half": 1.2 } }`
    * `analysis`: `{ "instrumental_vocal_energy_ratio": 0.05, "jump_semitones": 10 }` (valores iniciais; calibrados na T0.6)
    * `search`: `{ "results": 12, "lyrics_timeout_ms": 1500 }`
    * `server` também recebe `"sse_heartbeat_seconds": 15`. O bloco `scoring.heuristic` é criado na `T3.1`. Formato completo: `CONTRACTS.md` §11.
  * Criar `config/compatibility-weights.json` seguindo a estrutura de `CONTRACTS.md` §8.1 (pesos, limiares dos níveis `excellent`/`good`/`regular`/`low`, regra de incompatibilidade, qualidade de letra e penalidades da pré-análise). Os valores do documento são **iniciais** e serão calibrados na `T0.6`.
  * Escrever `README.md` com instruções de instalação cross-platform e aviso explícito de que o projeto destina-se exclusivamente a uso pessoal em `localhost` (Seção 15).
* **Critérios de Aceitação:**
  * Árvore de diretórios criada conforme Seção 12 do `ARCHITECTURE.md`.
  * Arquivos JSON válidos e carregáveis via `JSON.parse`.
  * `docs/` contém os três documentos; `npm run doctor` e `npm test` existem como scripts (podem falhar até as tasks correspondentes).
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T0.2` — Setup isolado do Worker Python por perfil de acelerador (`venv`)
* **Status:** `[x] COMPLETA`
* **Arquivos:**
  * `worker/requirements-base.txt`
  * `worker/setup/requirements-cpu.txt`
  * `worker/setup/requirements-cuda.txt`
  * `worker/setup/requirements-directml.txt`
  * `worker/setup/requirements-rocm.txt`
  * `worker/setup/requirements-mps.txt`
  * `worker/setup/install.py`
* **Detalhes de Implementação:**
  * **Regra Crítica (Seção 12.2.A):** Pacotes de aceleração (`torch`, `onnxruntime-gpu`, `onnxruntime-directml`, etc.) conflitam se instalados no mesmo ambiente. Existe **um único `worker/.venv`**, criado para **um** perfil de acelerador; o perfil ativo é gravado em `worker/accelerator_profile.json`. Trocar de perfil = recriar o `venv` (nunca instalar por cima).
  * `requirements-base.txt`: dependências comuns (`librosa`, `soundfile`, `numpy`, `scipy`), **sem** `torch` nem `onnxruntime`. O `audio-separator` declara dependências/extras de aceleração (ex.: `[cpu]`, `[gpu]`, `[dml]`): verificar na instalação; se não for possível mantê-lo no base sem puxar `torch`/`onnxruntime`, mover para os `requirements-<perfil>.txt` e registrar em `Notas de Execução`.
  * `requirements-<perfil>.txt`: dependências específicas fixadas por acelerador (`cpu`, `cuda`, `directml`, `rocm` apenas Linux, `mps` apenas macOS Apple Silicon).
  * `worker/setup/install.py`:
    * Detecta OS e GPU disponível (NVIDIA via `nvidia-smi`, Apple Silicon via `platform.machine() == 'arm64'` no Darwin, GPU Windows para DirectML).
    * Propõe o perfil adequado e aceita flag manual `--accelerator <perfil>` e `--force` (que apaga e **recria** o `venv` do zero, nunca instalando por cima).
    * Escolhe, entre os modelos suportados pelo `audio-separator` (preferência por modelo "karaokê" que separa voz principal de backing vocals), o modelo a usar, grava o nome em `config/default.json` (`worker.separation_model`) e baixa/valida o arquivo. Registrar a escolha em `Notas de Execução`.
* **Critérios de Aceitação:**
  * Execução limpa de `python worker/setup/install.py --accelerator cpu` cria `worker/.venv`, instala dependências sem conflito e grava `worker/accelerator_profile.json`.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T0.3` — Contrato Node ↔ Python v1 (CLI `run` e `doctor --json`, JSON Lines)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `worker/karaoke_worker/__init__.py`
  * `worker/karaoke_worker/__main__.py`
  * `worker/karaoke_worker/contract.py`
  * `worker/karaoke_worker/util/events.py`
  * `worker/karaoke_worker/util/hardware.py`
* **Detalhes de Implementação:**
  * Implementar CLI com `argparse`:
    * `python -m karaoke_worker run --job <caminho_job.json>`
    * `python -m karaoke_worker doctor --json`
  * Validar `contract_version == 1` na leitura de `job.json`.
  * Formatos exatos de `job.json`, eventos e do JSON de `doctor --json`: `CONTRACTS.md` §2. O evento `progress` da etapa `separate` inclui o campo opcional `device` (acelerador realmente usado).
  * **Isolamento de disco:** Garantir que `workdir` seja resolvido com `Path.resolve()` e que nenhuma etapa leia/escreva fora dele.
  * **Protocolo de Saída (Seção 5.3):**
    * `stdout` emite **exclusivamente** JSON Lines válidas (`flush=True` a cada linha): `progress`, `step_done`, `warning`, `error`, `done`.
    * `stderr` recebe logs livres de bibliotecas (redirecionar `stdout` de bibliotecas como `librosa`/`audio-separator` para `stderr` para não corromper o parser do Node).
    * Códigos de saída padronizados: `0` (sucesso), `10` (erro recuperável), `20` (dependência ausente), `30` (dados/áudio inválido), `130` (cancelado via `SIGINT`/`SIGTERM`).
  * `doctor --json` retorna: versão Python, perfil de acelerador instalado vs. hardware detectado, teste real de inicialização do acelerador (`cuda`/`mps`/`directml`/`cpu`), presença de `ffmpeg`, `yt-dlp` e modelos baixados, espaço livre em disco e `contract_version: 1`.
* **Critérios de Aceitação:**
  * `python -m karaoke_worker doctor --json` retorna JSON válido no `stdout` sem ruído de texto livre.
  * Sinais `SIGTERM` encerram o processo graciosamente com exit code `130`.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T0.4` — Etapas do pipeline (`download`, `separate`, `pitch`, `analyze`, `package`)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `worker/karaoke_worker/steps/download.py`
  * `worker/karaoke_worker/steps/separate.py`
  * `worker/karaoke_worker/steps/pitch.py`
  * `worker/karaoke_worker/steps/analyze.py`
  * `worker/karaoke_worker/steps/package.py`
* **Detalhes de Implementação:**
  * **Idempotência e Retomada (Seção 4 e 6.B):** Antes de rodar cada etapa, ler `manifest.json` em `workdir` (se existir); se a etapa já constar em `steps_done` e seus artefatos existirem e não estiverem vazios, pular a etapa emitindo `step_done`. Atualizar `manifest.json` de forma atômica ao final de cada etapa. O worker só escreve no manifest os campos de sua responsabilidade (`CONTRACTS.md` §4.2).
  * `download.py`: Invoca `yt-dlp` via `subprocess.run` com lista de argumentos (sem `shell=True`) para baixar o melhor stream de áudio e metadados (`title`, `uploader`/`channel`, `duration`). Retornar exit code `10` em falha de rede/YouTube. Grava `source` (`title`, `channel`, `duration`) no manifest.
  * `separate.py`: Executa `audio-separator` com o modelo configurado (preferência por modelo "karaokê" que isola voz principal de backing vocals). Gera stems temporários de voz e instrumental. Grava `device_used` no manifest.
  * `pitch.py`: Executa `librosa.pyin` (ou `torchcrepe` se configurado) sobre o stem de voz com `hop` de `0.02s`. Converte F0 para MIDI contínuo ($69 + 12 \cdot \log_2(f / 440)$) e gera `pitch_map.json` com arrays paralelos `midi` (`float | null`) e `conf` (`float`), além de `schema_version: 1`.
  * `analyze.py`: Calcula as métricas da Seção 10.2 (`voiced_ratio`, `mean_confidence`, `vocal_energy_ratio`, `bleed_estimate`, `backing_vocals_estimate`, `pitch_stability`) **conforme as definições operacionais de `CONTRACTS.md` §3** (normalizadas em 0–1, com o sentido de cada métrica). **Detecção de vídeo já instrumental (Seção 11):** se `vocal_energy_ratio < config.analysis.instrumental_vocal_energy_ratio`, reescreve `pitch_map.json` com `mode = "heuristic"` e emite `warning` `LOW_VOCAL_ENERGY`. Não calcula `lyrics_sync_quality` nem o nível de compatibilidade (isso é do Node, T4.2).
  * `package.py`: Converte os stems finais para `instrumental.flac` e `vocals.flac` via `ffmpeg`, grava no `manifest.json` os campos do worker (`CONTRACTS.md` §4.2) com `status: "ready"` e remove arquivos intermediários/temporários (`source.*`, `.wav` temporários). Não escreve `compatibility`, `lyrics` nem `user`.
* **Critérios de Aceitação:**
  * Dado um `job.json` válido, o worker gera `instrumental.flac`, `vocals.flac`, `pitch_map.json` e `manifest.json`.
  * Se interrompido após `separate`, uma segunda execução retoma diretamente da etapa `pitch`.
* **Subtarefas (pré-definidas; atualizar o status de cada uma):**
  * `[ ] T0.4.1` — `download.py` + helpers de manifest atômico/idempotência
  * `[ ] T0.4.2` — `separate.py` (modelo karaokê, `device_used`)
  * `[ ] T0.4.3` — `pitch.py` (`pitch_map.json`)
  * `[ ] T0.4.4` — `analyze.py` (métricas de `CONTRACTS.md` §3 e modo heurístico)
  * `[ ] T0.4.5` — `package.py` + teste de retomada após `separate`
* **Notas de Execução / Handoff:**
  * —

---

### `T0.5` — Scripts operacionais (`scripts/doctor.js`, `update-ytdlp.js`, `lib/venvPaths.js`)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `scripts/doctor.js`
  * `scripts/update-ytdlp.js`
  * `scripts/lib/venvPaths.js` (resolve o caminho do `python` e do `yt-dlp` em `worker/.venv`: `Scripts\` no Windows, `bin/` nos demais; fallback para o PATH no caso do `yt-dlp`; será reutilizado pelo backend)
* **Detalhes de Implementação:**
  * `scripts/doctor.js`:
    * Verifica versão do Node.js ($\ge 20$), existência do `venv` ativo em `worker/`, executa `<venv>/bin/python -m karaoke_worker doctor --json` (ou `Scripts\python.exe` no Windows), verifica `ffmpeg`, `yt-dlp` (versão e runtime JS se exigido) e espaço em disco.
    * Exibe relatório legível no terminal com instruções acionáveis para corrigir qualquer item falho.
    * Exporta função reutilizável para a rota `GET /api/health` do backend. Formato do relatório: `CONTRACTS.md` §2.4.
  * `scripts/update-ytdlp.js`:
    * Executa a atualização do `yt-dlp` (via `pip install -U yt-dlp` no `venv` ou binário gerenciado) e imprime a nova versão instalada.
* **Critérios de Aceitação:**
  * `node scripts/doctor.js` funciona em Windows, Linux e macOS e diagnostica corretamente ambiente íntegro vs. dependência ausente.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T0.6` — Spike obrigatório (~20 músicas) e calibração de limiares em `config/`
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `scripts/spike-benchmark.js` (script auxiliar de validação)
  * `scripts/spike-songs.json` (lista de ~20 `videoId`s fornecida pelo responsável; o agente não escolhe as músicas)
  * `config/default.json` (ajuste fino)
  * `config/compatibility-weights.json` (ajuste fino)
* **Detalhes de Implementação:**
  * Executar o pipeline completo em um conjunto diversificado de ~20 músicas (MPB, sertanejo, pagode, rock nacional, pop, faixas com coros densos, gravações ao vivo e faixas já instrumentais/karaokê).
  * Registrar tempos de processamento (GPU vs. CPU), `voiced_ratio`, `mean_confidence`, `vocal_energy_ratio` e qualidade auditiva dos stems.
  * Calibrar os pesos e limiares em `config/compatibility-weights.json` e `config/default.json` com base nas medições reais para garantir que músicas de estúdio bem isoladas recebam `excellent`/`good` e instrumentais recebam `incompatible` (acionando fallback heurístico). Inclui `analysis.instrumental_vocal_energy_ratio` e a revisão das definições de `CONTRACTS.md` §3 se alguma métrica não discriminar bem.
  * **Requer validação humana:** a avaliação auditiva dos stems e a aprovação final dos limiares são do responsável. O agente executa o benchmark, gera o relatório e deixa a task `[~] EM ANDAMENTO` com nota de handoff pedindo a validação; ela só vira `[x]` após a confirmação.
* **Critérios de Aceitação:**
  * Relatório gerado no terminal/log e `config/compatibility-weights.json` calibrado com valores empíricos validados.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —