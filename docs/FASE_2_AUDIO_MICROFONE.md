# Fase 2 — Dispositivos de Áudio e Microfone Amador

> Status das tasks: **somente neste arquivo** (fonte única). Painel de handoff e regras: `docs/tasks/TASKS.md`. Formatos: `docs/CONTRACTS.md`.

**Referências:** `ARCHITECTURE.md` (Seções 7, 8, 12.2.B, 14.3) e `FRONTEND_ARCHITECTURE.md` (Seções 5.3, 8.1, 10). Tempo/eventos e chaves de `localStorage`: `docs/CONTRACTS.md` §6 e §10.
**Objetivo:** Implementar seleção persistente de entrada e saída de áudio, cadeia de captura otimizada para microfones amadores (sem AEC/NS/AGC, filtros passa-faixa, `AudioWorklet`), detecção robusta de F0 com `pitchy` local e fluxo guiado de calibração de ~10 segundos.

---

### `T2.1` — Bundle ESM local de `pitchy` em `frontend/vendor/pitchy.js`
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/vendor/pitchy.js`
  * `frontend/vendor/VENDOR_VERSIONS.md`
* **Detalhes de Implementação:**
  * **Regra Crítica (Seção 12.2.B):** O navegador e o `AudioWorkletGlobalScope` não resolvem *bare imports* (`import ... from 'pitchy'`). Não deve haver etapa de build no fluxo normal de execução do app.
  * Instalar `pitchy` temporariamente ou gerar uma única vez um bundle ES Module autocontido (ex.: via `npx esbuild` a partir de `node_modules/pitchy`) salvando o arquivo final em `frontend/vendor/pitchy.js` (exportando `PitchDetector`).
  * Registrar em `frontend/vendor/VENDOR_VERSIONS.md` a versão exata empacotada e o comando usado para reproduzir o bundle caso seja atualizado no futuro.
* **Critérios de Aceitação:**
  * `import { PitchDetector } from '../../vendor/pitchy.js'` funciona diretamente no navegador sem bundler e sem erros de MIME type ou dependências ausentes.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T2.2` — Gerenciador de Dispositivos (`audioDevices.js`, `setSinkId`, hot-plug)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/settings/audioDevices.js`
* **Detalhes de Implementação:**
  * **Permissão e Listagem (Seção 8.2):** Solicitar permissão inicial de microfone antes de chamar `navigator.mediaDevices.enumerateDevices()` para que os `label`s dos dispositivos fiquem visíveis; separar em listas `inputs` (`audioinput`) e `outputs` (`audiooutput`).
  * **Detecção de Suporte de Saída (Seção 8.3):** Checar suporte a `AudioContext.prototype.setSinkId` ou `HTMLMediaElement.prototype.setSinkId` (via `MediaStreamAudioDestinationNode` + `<audio>`). Se não suportado (ex.: Firefox/Safari), expor flag `outputSelectionSupported: false` para a UI desabilitar o seletor e explicar o motivo.
  * **Hot-plug (`devicechange`):** Escutar `navigator.mediaDevices.addEventListener('devicechange', ...)`. Se o dispositivo de entrada ou saída ativo durante uma partida for desconectado, emitir o evento `devicelost` (`CONTRACTS.md` §6), que pausa o jogo automaticamente (`audioEngine.pause()`) e solicita nova escolha sem perder o estado da partida.
  * **Persistência:** Salvar `inputDeviceId` e `outputDeviceId` no `localStorage` sob chave versionada (`karaoke.audioDevices.v1`) dentro de `try/catch`. Se o ID salvo não existir mais, reverter para `"default"` e notificar. Formato em `CONTRACTS.md` §10.
  * **Preservação de Posição:** Ao trocar saída de áudio, acionar `audioEngine.consolidateAndRebuildRouting()` para nunca reiniciar a música. Em seguida, reconstruir a cadeia do microfone no mesmo contexto (`micCapture`, T2.3) e reaplicar a latência efetiva do novo par entrada/saída (`CONTRACTS.md` §10).
* **Critérios de Aceitação:**
  * Trocar saída durante a reprodução mantém o tempo atual da música; desconectar o microfone durante o jogo pausa a partida imediatamente.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T2.3` — Cadeia de Captura de Microfone (`micCapture.js` + `pitchWorklet.js`)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/audio/micCapture.js`
  * `frontend/src/audio/pitchWorklet.js`
* **Detalhes de Implementação:**
  * **Constraints Obrigatórias (Seção 7.1):**
    ```js
    audio: {
      deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
    ```
  * Inspecionar `stream.getAudioTracks()[0].getSettings()` após abrir o stream; se `echoCancellation`, `noiseSuppression` ou `autoGainControl` continuarem `true` (comum em headsets Bluetooth/drivers), registrar flag de aviso para a UI. Detectar também pelo `label` se o microfone é Bluetooth para exibir recomendação de uso com fio (Seção 7.4).
  * **Grafo Web Audio (Seção 7.2):**
    `MediaStreamSource` $\to$ `GainNode` (ganho de software definido na calibração) $\to$ `BiquadFilterNode` (`highpass`, ~`80 Hz`) $\to$ `BiquadFilterNode` (`lowpass`, ~`1200 Hz`) $\to$ `AudioWorkletNode` (`pitchWorklet`).
  * **Retorno opcional (*monitoring*):** Conectar saída do `GainNode` a um `monitoringGainNode` (valor `0` por padrão para evitar microfonia).
  * `pitchWorklet.js` (Seção 12.2.B): Acumula amostras em janela deslizante de `2048` amostras com hop de `512` amostras, calcula RMS do bloco e envia via `port.postMessage({ samples, rms, contextTime })` para a thread principal (evitando limitações de escopo do worklet). Implementar fallback via `AnalyserNode` caso `audioWorklet` não esteja disponível.
  * **Contexto compartilhado:** o grafo é criado no **mesmo `AudioContext` do `AudioEngine`** (`audioEngine.getContext()`), para que o tempo do microfone e o relógio mestre sejam comparáveis. O `contextTime` enviado pelo worklet aproxima o **fim** da janela de 2048 amostras (`CONTRACTS.md` §6). `micCapture` expõe um método para **reconstruir** a cadeia (usado após trocar de dispositivo).
* **Critérios de Aceitação:**
  * Captura entrega blocos de 2048 amostras com RMS e timestamp preciso sem vazar som do microfone para as caixas por padrão.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T2.4` — Detector de F0 e Pós-Processamento (`pitchDetector.js`, histerese, vazamento)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/audio/pitchDetector.js`
* **Detalhes de Implementação:**
  * Usa `PitchDetector.forFloat32Array(2048)` de `frontend/vendor/pitchy.js` com o `sampleRate` real do `AudioContext`.
  * **Pipeline de Robustez para Hardware Amador (Seção 7.4):**
    1. **Noise gate dinâmico com histerese:** compara `rms` do bloco contra o piso de ruído calibrado do dispositivo.
    2. **Filtro de faixa humana:** descarta frequências fora de `65 Hz` a `1200 Hz`.
    3. **Histerese de clareza:** ativa detecção quando `clarity >= config.clarity_on` (ex.: `0.85`) e só desativa quando `clarity < config.clarity_off` (ex.: `0.70`).
    4. **Filtro de mediana:** janela de `3` a `5` frames sobre o valor MIDI contínuo para eliminar saltos espúrios de oitava.
    5. **Hold curto (`~100–150 ms`):** durante breves quedas (consoantes, respiração), mantém a última nota válida pelo tempo configurado antes de emitir `midi: null`.
  * **Heurística Leve de Vazamento das Caixas (Seção 7.4):**
    * Monitora janelas de `50–100 ms` durante trechos onde `pitch_map.json` indica ausência de voz (`midi === null`).
    * Se o RMS do microfone ficar sustentadamente acima do piso de ruído acompanhando o envelope do instrumental (testando atrasos de `0–300 ms`) **e** o detector não indicar canto ativo do usuário (clareza baixa), emite evento suave `speaker_bleed_detected` para aviso não-bloqueante na UI.
  * **Saída:** emite `frame` com `{ songTime, midi, clarity, rms }`, onde `songTime` é o **centro** da janela (`contextTimeToSongTime(contextTime) - (2048/2)/sampleRate`, `CONTRACTS.md` §6), e o evento `speaker_bleed_detected`. Todos os limiares vêm de `config.audio` (via store), nunca de constantes locais.
* **Critérios de Aceitação:**
  * Cantar uma nota sustentada produz contorno MIDI estável sem saltos de oitava; pausas de consoantes são suavizadas pelo *hold*.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T2.5` — Calibração Guiada (`micCalibration.js`), Assistente e Configurações de Áudio
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/settings/micCalibration.js`
  * `frontend/src/ui/screens/settingsAudio.js` (ou seção integrada em `settings.js`)
  * `frontend/src/ui/dialogs/firstRunWizard.js`
* **Detalhes de Implementação:**
  * **Fluxo Guiado de ~10 Segundos (Seção 7.3):**
    1. **Etapa 1 — Silêncio (`2.5 s`):** mede RMS ambiente para definir o piso de ruído (*noise gate*).
    2. **Etapa 2 — Canto/Fala (`4.5 s`):** usuário canta "lá, lá, lá"; calcula ganho de software recomendado, extensão vocal aproximada (nota grave $\leftrightarrow$ aguda) e taxa de frames com alta clareza.
    3. **Etapa 3 — Veredito:** classifica microfone em **Bom**, **Aceitável** ou **Fraco** com base na relação sinal-ruído e estabilidade, sugerindo dificuldade padrão (`Fácil` se *Fraco*).
    4. **Etapa 4 — Teste de Vazamento (`3 s`, opcional/quando saída for caixa de som):** reproduz ruído rosa/trecho de áudio em volume de jogo enquanto usuário fica em silêncio e mede retorno no mic; recomenda fones se houver vazamento alto.
  * **Compensação de Latência (Seção 7.5):**
    * Slider manual `0–400 ms` salvo **por par `(inputDeviceId, outputDeviceId)`** em `karaoke.latency.v1`. O ajuste feito por música (pausa/pré-jogo) é gravado no manifest; ordem de resolução da latência efetiva em `CONTRACTS.md` §10.
    * Calibração assistida opcional por cliques acústicos (com aviso claro de que funciona apenas em caixas de som, não em fones).
  * **Controles da Tela:** Seletores de entrada/saída, botão "Testar saída" (tom curto), medidor visual de nível/clareza em tempo real, volumes (instrumental, voz guia, retorno do mic) e alertas de processamento forçado pelo SO ou Bluetooth.
* **Critérios de Aceitação:**
  * Perfil calibrado é salvo por dispositivo no `localStorage` (`karaoke.micProfiles.v1`) e reaplicado automaticamente ao recarregar a página.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —