# Fase 4 — Produto Completo, Compatibilidade, Jogadores e Histórico

> Status das tasks: **somente neste arquivo** (fonte única). Painel de handoff e regras: `docs/tasks/TASKS.md`. Formatos: `docs/CONTRACTS.md`.

**Referências:** `ARCHITECTURE.md` (Seções 6.A, 10, 11, 13.1, 14.4) e `FRONTEND_ARCHITECTURE.md` (Seções 3, 4, 5, 8, 9, 10, 11, 13). Formatos de rotas, compatibilidade e histórico: `docs/CONTRACTS.md` §5, §8, §9, §10.
**Objetivo:** Completar o produto com busca no YouTube, motor de compatibilidade (pré e pós-análise), persistência local atômica de jogadores e histórico com exportação CSV/TXT, abstração de modos de jogo e todas as telas finais do MVP.

---

### `T4.1` — Busca no YouTube (`searchService.js`) e Biblioteca (`library` routes)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `backend/services/searchService.js`
  * `backend/routes/search.js`
  * `backend/routes/library.js`
* **Detalhes de Implementação:**
  * `searchService.js` (Seção 6.A):
    * Executa `yt-dlp` (caminho via `scripts/lib/venvPaths.js`) por `spawn` com array de argumentos: `["--dump-json", "--flat-playlist", "--no-warnings", "ytsearch" + config.search.results + ":" + query]`.
    * Extrai `videoId`, `title`, `channel`, `duration` e `thumbnail`.
    * Em paralelo (timeout `config.search.lyrics_timeout_ms` e `Promise.allSettled`, para não travar a busca), consulta o `lyricsService` para indicar `hasSyncedLyrics: boolean` em cada resultado. **Não** calcula compatibilidade aqui.
  * Rotas:
    * `GET /api/search?q=`: valida termo não vazio e retorna lista de resultados.
    * `GET /api/library`: lista músicas em cache com `status === "ready"`, ordenadas por `last_played` / data de criação, incluindo selo de compatibilidade e tamanho ocupado em disco. Formato: `CONTRACTS.md` §5.
    * `DELETE /api/songs/:id`: remove diretório da música do cache (bloqueando se houver job ativo).
* **Critérios de Aceitação:**
  * `GET /api/search?q=evidencias` retorna resultados do YouTube com indicador de letra sincronizada sem executar download de áudio.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T4.2` — Serviço de Compatibilidade (`compatibilityService.js` — Fases 1 e 2)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `backend/services/compatibilityService.js`
  * `scripts/test-compatibility.js`
* **Detalhes de Implementação:**
  * Fórmulas, estrutura de `config/compatibility-weights.json`, níveis e textos de motivos: `CONTRACTS.md` §8.
  * **Fase 1 — Pré-análise (Seção 10.2):** função pura, executada ao escolher a música, usando só título, canal, duração e o candidato de letra do LRCLIB. Retorna `{ level, score, reasons, provisional: true }` com motivos em pt-BR. É devolvida por `POST /api/prepare` (campo `compatibility`).
  * **Fase 2 — Pós-análise (Seções 10.2 e 10.3):** combina as métricas gravadas pelo worker em `manifest.metrics` com `lyrics_sync_quality` (calculada aqui, a partir de `lyrics.json` e `manifest.source.duration`) usando os pesos do arquivo de config. Retorna `{ level, score, reasons, provisional: false }`.
  * **Integração:** registrar um hook no `onJobDone` do `jobQueue` (T1.2) que grava `manifest.compatibility` e `manifest.lyrics.sync_quality` antes de o job virar `ready`; e recalcular quando `PATCH /api/songs/:id` trocar o candidato de letra.
  * Testes (`node --test scripts/test-compatibility.js`): casos de pré-análise (palavras-chave, duração anômala, letra ausente), pós-análise (cada nível, regra de incompatibilidade) e `lyrics_sync_quality`.
* **Critérios de Aceitação:**
  * Pré-análise responde em $< 50\text{ ms}$ (sobre dados em memória); pós-análise grava `compatibility` definitiva no `manifest.json` ao término do job; `scripts/test-compatibility.js` passa.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T4.3` — Persistência de Jogadores e Histórico (`playerService`, `historyService`, CSV/TXT)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `backend/services/playerService.js`
  * `backend/services/historyService.js`
  * `backend/routes/players.js`
  * `backend/routes/history.js`
  * `scripts/test-history.js`
* **Detalhes de Implementação:**
  * **Armazenamento Atômico e Seguro (`FRONTEND_ARCHITECTURE.md` Seção 4.4):**
    * Arquivos `backend/data/players.json` e `backend/data/history.json` (com `schema_version: 1`) e pasta `backend/data/backups/`.
    * Fila única de serialização de escrita por arquivo; escrita em `.tmp` seguida de `fs.rename` atômico e backup rotativo (manter últimos 5 backups). Se o `rename` falhar com `EPERM`/`EBUSY` (ocorre no Windows), repetir algumas vezes antes de falhar.
    * **Recuperação de Corrupção:** Se `JSON.parse` falhar na leitura, renomear arquivo para `*.corrupt-<timestamp>`, registrar alerta e inicializar estrutura limpa sem perder o arquivo corrompido.
  * **Regras de Jogadores (Seção 4.2):**
    * Nome: 1 a 30 caracteres, `trim()`, caracteres de controle removidos, acentos e emojis permitidos, deduplicação *case-insensitive*.
    * `DELETE /api/players/:id?history=keep|delete`: se `keep`, mantém entradas no histórico com `player_id: null` preservando `player_name` original.
  * **Regras de Histórico e Exportação (Seção 4.3, 4.4 e 13):**
    * Validar rigorosamente todos os campos no `POST /api/history` conforme a tabela de `CONTRACTS.md` §9.1 (inclui `score` entre `0.0` e `10.0`). O `id` é gerado no cliente e o `POST` é **idempotente por `id`** (reenvio não duplica; ver §5.2).
    * Rotas completas, com os formatos de `CONTRACTS.md` §5.2: `GET/POST/PATCH/DELETE /api/players`, `GET/POST/DELETE /api/history`, `GET /api/history/:id`, `GET /api/history/rankings?video_id=`, `GET /api/history/export?format=csv|txt&player_id=&bom=1` (mais `sep` e `decimal` opcionais).
    * **CSV pt-BR:** colunas e regras em `CONTRACTS.md` §9.2 — separador `;`, vírgula decimal (ex.: `8,7`), UTF-8 com BOM opcional (`\uFEFF`), escape padrão de CSV para campos com separador, aspas ou quebra de linha.
    * **TXT:** relatório tabular/legível agrupado por jogador.
* **Critérios de Aceitação:**
  * Escritas concorrentes não corrompem o JSON; CSV exportado abre no Excel com acentos e notas decimais corretos. `node --test scripts/test-history.js` cobre escrita concorrente, recuperação de arquivo corrompido, validação de entrada, idempotência por `id`, exclusão de jogador (`keep`/`delete`) e geração do CSV (separador, vírgula decimal, BOM).
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T4.4` — Abstração de Modos (`standard` + placeholder `championship`) e Clientes Front
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/game/session.js`
  * `frontend/src/game/modes/registry.js`
  * `frontend/src/game/modes/standard.js`
  * `frontend/src/game/modes/championship.js`
  * `frontend/src/players/playerStore.js`
  * `frontend/src/history/historyClient.js`
* **Detalhes de Implementação:**
  * **Abstração de Modos (`FRONTEND_ARCHITECTURE.md` Seção 3.3):**
    * `registry.js`: registra modos disponíveis e suas metadados de exibição.
    * `standard.js`: implementa `id: 'standard'`, `setup`, `onStart`, `onFrame`, `onEnd` (grava entrada no histórico) e `summary`.
    * `championship.js`: placeholder contendo apenas `{ id: 'championship', enabled: false, badgeKey: 'mode.coming_soon' }` sem nenhuma lógica de torneio.
  * `playerStore.js`: gerencia jogador ativo (incluindo modo `"Convidado"`), lembra último jogador no `localStorage` e sincroniza CRUD com `/api/players`. Chaves de `localStorage`: `CONTRACTS.md` §10.
  * `historyClient.js`: envia partidas concluídas para `POST /api/history`; se o backend estiver temporariamente inacessível ao fim da partida, salva a entrada numa fila pendente no `localStorage` (`karaoke.pendingHistory.v1`) e reenvia automaticamente assim que a conexão voltar (`FRONTEND_ARCHITECTURE.md` Seção 8.3 e 10). A entrada já carrega o `id` UUID gerado na T3.4; como o backend é idempotente por `id`, reenviar a fila pendente é seguro (`CONTRACTS.md` §5.2 e §9.1).
* **Critérios de Aceitação:**
  * Desligar o backend durante o fim de uma partida preserva a nota localmente e a sincroniza automaticamente quando o backend volta.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —

---

### `T4.5` — Telas de Fluxo Principal (Início, Busca, Preparo SSE, Pré-Jogo)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/ui/screens/home.js`
  * `frontend/src/ui/screens/search.js`
  * `frontend/src/ui/screens/prepare.js`
  * `frontend/src/ui/screens/pregame.js`
  * `frontend/src/ui/components/compatibilityBadge.js`
* **Detalhes de Implementação:**
  * **Início (`#/`):** Cartão ativo *Modo Karaokê*, cartão desabilitado *Modo Campeonato — Em breve*, seletor/criação rápida de jogador (ou Convidado), barra de busca e atalhos para Biblioteca, Histórico e Configurações. Dispara assistente de calibração na primeira visita.
  * **Resultados da Busca (`#/busca?q=`):** Lista thumbnail, título, canal, duração e selo de "Letra sincronizada disponível". **Proibido exibir compatibilidade aqui (`ARCHITECTURE.md` 10.1).**
  * **Preparo (`#/preparo/:videoId`):** Se a música já estiver pronta no cache, redireciona direto para `#/pre-jogo/:videoId`. Caso contrário, chama `POST /api/prepare` enviando os metadados do resultado escolhido na busca (guardados na store) e abre o SSE (`CONTRACTS.md` §5.1). Exibe barra de progresso por etapa (*Na fila $\to$ Baixando $\to$ Separando voz $\to$ Gerando gabarito $\to$ Analisando $\to$ Pronto*), a estimativa de tempo quando possível (com base em GPU/CPU e duração), indica GPU ou CPU (campo `device` dos eventos), mostra a compatibilidade provisória (devolvida por `POST /api/prepare`) e o botão *Cancelar*. Se a conexão cair, reconecta o SSE e consulta `GET /api/jobs/:id`.
  * **Pré-Jogo (`#/pre-jogo/:videoId`):** Exibe selo de compatibilidade definitivo (Fase 2) com motivos em linguagem simples, opções *Jogar assim mesmo*, *Escolher outra versão* (volta aos resultados da busca) e *Trocar letra* (modal com candidatos do LRCLIB), além de ajustes rápidos (dificuldade, volume voz guia, exibir vídeo, latência) e botão *Cantar!* (que satisfaz a política de autoplay do navegador).
* **Critérios de Aceitação:**
  * Fluxo completo `Início -> Busca -> Preparo -> Pré-Jogo -> Jogo -> Resultado` funciona sem intervenção técnica.
* **Subtarefas (pré-definidas; atualizar o status de cada uma):**
  * `[ ] T4.5.1` — `components/compatibilityBadge.js` e `screens/home.js`
  * `[ ] T4.5.2` — `screens/search.js` (sem selo de compatibilidade)
  * `[ ] T4.5.3` — `screens/prepare.js` (SSE, etapas, cancelar, reconexão)
  * `[ ] T4.5.4` — `screens/pregame.js` (selo final, ajustes rápidos, trocar letra, *Cantar!*)
* **Notas de Execução / Handoff:**
  * —

---

### `T4.6` — Telas de Gestão (Biblioteca, Histórico/Rankings, Configurações Completas)
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * `frontend/src/ui/screens/library.js`
  * `frontend/src/ui/screens/history.js`
  * `frontend/src/ui/screens/settings.js`
* **Detalhes de Implementação:**
  * **Biblioteca (`#/biblioteca`):** Lista músicas em cache com selo de compatibilidade, última vez cantada (`last_played`), espaço usado em disco e ações (*Cantar*, *Ajustar Letra*, *Reprocessar* — `DELETE /api/songs/:id` seguido de `POST /api/prepare` — e *Remover do Cache*).
  * **Histórico (`#/historico`):** Filtros por jogador, música, período e dificuldade; aba de rankings locais por música; estatísticas do jogador (total, média, recorde); selo visual quando nota vier de dificuldade `Fácil` ou compatibilidade `Baixa`; botões *Exportar CSV*, *Exportar TXT* e *Limpar Histórico* (com diálogo de confirmação).
  * **Configurações (`#/configuracoes`):** Abas organizadas para:
    1. *Áudio:* dispositivos entrada/saída, calibração do mic, slider de latência, volumes.
    2. *Jogo:* dificuldade padrão, exibir vídeo por padrão, contagem regressiva, exibir pontuação parcial, transposição automática (desligada por padrão), gravar partidas abandonadas (desligada por padrão), gravar partidas de Convidado (ligada por padrão).
    3. *Aparência:* tema escuro/claro, tamanho da fonte da letra, domínio do embed (`youtube.com` / `youtube-nocookie.com`).
    4. *Dados:* gestão de jogadores (criar, renomear, excluir com escolha de manter/apagar histórico), limpeza de cache. Formato do CSV exportado (pt-BR padrão ou alternativo: `sep=,` e `decimal=dot`, `CONTRACTS.md` §5.2).
    5. *Diagnóstico:* exibe resultado ao vivo de `GET /api/health` (`doctor`) e botão de atualizar `yt-dlp`.
  * As preferências persistem em `karaoke.prefs.v1` (`CONTRACTS.md` §10). Padrões: dificuldade `normal`, vídeo ligado, contagem de 3 s, tema escuro, domínio do embed `config.audio.youtube_embed_domain`.
* **Critérios de Aceitação:**
  * Todas as abas de configuração persistem corretamente; exportação CSV e TXT baixa os arquivos diretamente no navegador.
* **Subtarefas (pré-definidas; atualizar o status de cada uma):**
  * `[ ] T4.6.1` — `screens/library.js`
  * `[ ] T4.6.2` — `screens/history.js` (filtros, rankings, estatísticas, exportar, limpar)
  * `[ ] T4.6.3` — `screens/settings.js` — abas Áudio e Jogo
  * `[ ] T4.6.4` — `screens/settings.js` — abas Aparência, Dados e Diagnóstico
* **Notas de Execução / Handoff:**
  * —

---

### `T4.7` — Polimento Final, Renderização Segura, Acessibilidade e Validação E2E do MVP
* **Status:** `[ ] NÃO INICIADA`
* **Arquivos:**
  * Auditoria transversal em `frontend/src/**` e `backend/**`
* **Detalhes de Implementação:**
  * **Renderização segura (`FRONTEND_ARCHITECTURE.md` Seções 4.2 e 15.4):** nome de jogador, título, canal e letra são sempre renderizados como texto (convenção em vigor desde a T1.4; aqui é a auditoria final).
  * **Acessibilidade (`FRONTEND_ARCHITECTURE.md` Seção 11.1):** Verificar navegação completa por teclado (`Tab`, `Enter`, `Esc`), foco visível, `aria-label` em controles de ícone e contraste adequado nos temas claro e escuro.
  * **Checklist de Critérios de Aceitação do MVP (`ARCHITECTURE.md` 14.4 e `FRONTEND_ARCHITECTURE.md` 11.4):** validar todos os itens abaixo e registrar o resultado em `Notas de Execução`.
    * `ARCHITECTURE.md` 14.4: (1) fluxo busca → preparo → jogo → nota sem intervenção manual; (2) progresso em todas as etapas e cancelamento funcionando; (3) segunda execução da mesma música carrega do cache em poucos segundos; (4) letra sincronizada com offset ajustável, e jogo continua sem letra; (5) escolha de microfone e saída persiste; (6) selo de compatibilidade aparece após escolher a música, com motivos; (7) falha do vídeo do YouTube não interrompe o jogo.
    * `FRONTEND_ARCHITECTURE.md` 11.4: (1) jogador informa o nome, canta e a partida aparece no histórico persistida em arquivo no backend; (2) histórico exportável em CSV e TXT e dados sobrevivem a limpar o navegador; (3) cartão do Modo Campeonato aparece como "Em breve" sem afetar nada; (4) vídeo aparece por padrão, pode ser desligado, e sua falha não interrompe a partida; (5) selo de compatibilidade aparece após a escolha, não na lista de resultados; (6) pausar, trocar a saída de áudio e retomar não reinicia a música; (7) pista de afinação mostra o cursor dobrado para a oitava do gabarito.
    * Testes de dispositivos (`ARCHITECTURE.md` 14.3): trocar microfone e saída durante a sessão, remover dispositivo durante o jogo, negar permissão, Chromium e Firefox, microfone Bluetooth e embutido. **Exigem hardware e validação humana**: o agente prepara o roteiro e registra em `Notas de Execução` o que ficou pendente para o responsável.
    * Banner persistente com o backend encerrado (criado na T1.4) e fila local do histórico reenviando ao voltar (T4.4).
  * **Auditoria de segurança de renderização:** buscar (`grep`) por `innerHTML`, `outerHTML`, `insertAdjacentHTML` e `document.write` em `frontend/src/**`; todo uso com dado dinâmico deve ser substituído por `textContent`/nós DOM. Testar nomes com acento, emoji e `<script>` no nome do jogador e no título.
* **Critérios de Aceitação:**
  * Todos os itens dos checklists 14.4 (`ARCHITECTURE.md`) e 11.4 (`FRONTEND_ARCHITECTURE.md`) validados e aprovados.
* **Subtarefas (opcional - preencher sob demanda):**
  * *(Nenhuma subtarefa criada)*
* **Notas de Execução / Handoff:**
  * —