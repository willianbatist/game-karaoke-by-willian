# Especificação Técnica: Palco Responsivo (1080p/2K/4K), Vídeo Limpo, Favoritos Globais e Aba de Preparo

**Projeto:** `game-karaoke-by-willian`  
**Versão do Documento:** 1.0  
**Status:** Especificação Técnica para Implementação  
**Documentos Relacionados:** `docs/ARCHITECTURE.md` (v2.2), `docs/FRONTEND_ARCHITECTURE.md` (v1.0), `docs/MELHORIAS_PONTUACAO_EXPERIENCIA.md` (v1.0)

---

## 1. Resumo Executivo

Este documento detalha o projeto técnico de quatro melhorias de interface, ergonomia e fluxo operacional identificadas durante o uso real do sistema em monitores de alta resolução (`2560x1440` / 2K):

1. **Palco Responsivo Full-Viewport (`1080p`, `2K` e `4K`) com Vídeo Proporcional (`16:9`) e Letra Centralizada:** Elimina o espaço ocioso na metade inferior da tela durante a partida, escala fluidamente entre `1080p`, `2K` e `4K`, mantém o vídeo de fundo em sua proporção natural sem distorção e centraliza a letra sincronizada no centro focal do palco.
2. **Supressão Definitiva de Legendas Automáticas e Anotações do YouTube:** Impede que legendas geradas automaticamente pelo player do YouTube sobreponham a letra sincronizada do karaokê.
3. **Sistema Global de Músicas Favoritas (Ícone Estrela `★`):** Permite marcar músicas como favoritas diretamente nos cards da Tela Inicial e da Biblioteca, com persistência global no `manifest.json` de cada faixa, ordenação prioritária e filtro rápido.
4. **Aba "Preparando" no Cabeçalho com Contador Dinâmico:** Adiciona um ponto de acesso direto no menu superior para acompanhar em tempo real todas as músicas em download ou processamento na fila do worker.

---

## 2. Diagnóstico dos Problemas Atuais

### 2.1 Subaproveitamento vertical em monitores 2K/4K e alinhamento no topo
* **Sintoma observado:** Em monitores QHD (`2560x1440`), o contêiner da tela de partida (`#play-shell`) ocupa apenas a metade superior da janela, deixando cerca de 45% da altura da tela vazia abaixo dos controles de reprodução. Além disso, o bloco da letra sincronizada fica deslocado e o vídeo de fundo ocupa uma área pequena.
* **Causa raiz técnica:** O layout de `play.css` utiliza alturas fixas ou `min-height: auto` sem distribuição flexível da altura total da viewport (`100dvh`), e o contêiner do vídeo não possui regras de dimensionamento proporcional (`aspect-ratio`) acopladas à altura disponível da `.stage-arena`.

### 2.2 Poluição visual por legendas automáticas do YouTube
* **Sintoma observado:** Mesmo quando o vídeo original não possui faixa de legenda oficial, o IFrame Player do YouTube ativa legendas automáticas (ASR) sobre o vídeo de fundo, conflitando visualmente com a letra sincronizada (`.lrc`) renderizada pelo karaokê.
* **Causa raiz técnica:** Configurar apenas `cc_load_policy: 0` na inicialização do `YT.Player` não impede que o player carregue o módulo interno de legendas (`captions` / `cc`) conforme o idioma da sessão do navegador ao iniciar o `playVideo()`.

### 2.3 Dificuldade de localizar músicas preferidas conforme o cache cresce
* **Sintoma observado:** Com o aumento do acervo local (limite de cache de 10 GB), encontrar rapidamente as músicas mais cantadas exige rolar toda a grade da Biblioteca ou da Tela Inicial.
* **Causa raiz técnica:** O schema atual do `manifest.json` de cada música não possui metadado de preferência global (`favorite`), nem há ordenação ou filtro dedicado na interface.

### 2.4 Falta de visibilidade da fila de preparo durante a navegação
* **Sintoma observado:** Ao enfileirar músicas para preparo e retornar para a Tela Inicial ou Biblioteca para cantar outra faixa, o usuário perde a visibilidade do progresso dos jobs ativos porque não há uma aba dedicada no cabeçalho principal.
* **Causa raiz técnica:** O cabeçalho (`frontend/index.html`) possui apenas quatro links (`Início`, `Biblioteca`, `Histórico` e `Configurações`), e a tela de preparo (`prepareView.js`) só é acessada diretamente após disparar uma busca ou clique em preparo.

---

## 3. Especificação Técnica Detalhada e Justificativas

### 3.1 Palco Responsivo Full-Viewport (`1080p`, `2K` e `4K`) com Vídeo `16:9` e Letra Centralizada

#### Arquitetura de Layout (`play.css` + `playView.js`)
1. **Ocupação total da altura da tela sem barra de rolagem indesejada:**
   * Quando a rota `#/play/:videoId` estiver ativa, `#play-shell` assume `height: 100dvh` (com fallback `100vh`), `display: flex`, `flex-direction: column` e `justify-content: space-between`.
   * A barra superior (`.play-topbar`) e o HUD vocal (`.vocal-hud-bar`) mantêm altura intrínseca no topo; o painel de timeline e mixer (`.play-controls-card`) fica ancorado na base; e a arena central (`.stage-arena`) recebe `flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden;`, absorvendo 100% do espaço vertical restante em qualquer resolução (`1920x1080`, `2560x1440` ou `3840x2160`).
2. **Vídeo do YouTube com proporção natural (`16:9`) e zero distorção:**
   * O contêiner `#stage-video-wrapper` será posicionado como camada de fundo centralizada (`position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none;`).
   * O elemento interno `#yt-player-target` (e o `<iframe>` gerado pela API do YouTube) receberá dimensionamento restrito pela proporção natural:
     ```css
     .stage-video-frame {
       aspect-ratio: 16 / 9;
       height: 100%;
       width: auto;
       max-width: 100%;
       max-height: 100%;
       object-fit: contain;
     }
     ```
   * Dessa forma, o vídeo cresce até tocar a borda superior e inferior da arena mantendo rigorosamente a proporção `16:9` (ou adaptando-se sem cortes nem esticamento caso a janela seja estreita), com uma camada de vinheta/escurecimento (`background: radial-gradient(...)` / `rgba(10, 14, 24, 0.58)`) garantindo contraste absoluto para a pista e para a letra.
3. **Centralização da letra e escala tipográfica fluida (`clamp()`):**
   * Dentro da `.stage-arena`, a pista de afinação (`#pitch-lane-wrapper`) ocupa o topo da arena com altura fluida `height: clamp(130px, 22vh, 260px);`, recalculando automaticamente a resolução interna via o `ResizeObserver` já presente em `pitchLane.js`.
   * O bloco de letra sincronizada (`#lyrics-overlay`) ocupa a área central restante da arena (`flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: clamp(1rem, 2.5vh, 2.5rem);`), garantindo que o verso atual fique perfeitamente centralizado no meio da tela.
   * Tamanhos de fonte escalam proporcionalmente à viewport usando `clamp()`:
     * Verso atual (`.lyric-current`): `font-size: clamp(1.65rem, 2.8vw, 3.25rem);`
     * Verso anterior e próximo (`.lyric-prev`, `.lyric-next`): `font-size: clamp(1.05rem, 1.5vw, 1.75rem);`
     * Barra de progresso do verso (`.lyric-line-progress`): `width: min(560px, 68vw);`

#### Justificativa Técnica
* **Por que `100dvh` + `flex: 1` em vez de media queries fixas para 1080p/2K/4K?** Media queries baseadas em pixels quebram quando o usuário redimensiona a janela ou usa escala de DPI do Windows (ex.: 125% ou 150% em monitores 2K/4K). Um layout flexível com `clamp()` se adapta continuamente a qualquer resolução ou fator de escala do sistema operacional.
* **Por que preservar `aspect-ratio: 16 / 9` em vez de esticar o vídeo (`100% x 100%`)?** Forçar largura e altura independentes em um `<iframe>` de vídeo causa distorção geométrica nos rostos e textos do clipe, além de gerar barras pretas internas irregulares no player do YouTube.

---

### 3.2 Desativação de Legendas Automáticas e Anotações do YouTube (`youtubePlayer.js`)

#### Solução Técnica
1. **Parâmetros de inicialização (`playerVars`):**
   * Configurar explicitamente no construtor `new YT.Player(...)`:
     * `cc_load_policy: 0` (desabilita exibição padrão de legendas fechadas)
     * `iv_load_policy: 3` (desabilita anotações e cards interativos sobre o vídeo)
     * `rel: 0` (restringe vídeos relacionados ao mesmo canal)
     * `modestbranding: 1` (minimiza sobreposições visuais do player)
     * `playsinline: 1`
2. **Descarregamento ativo dos módulos de legenda em runtime:**
   * Como o YouTube pode reativar legendas automáticas ao iniciar o playback, implementar um helper interno `disableCaptions(ytInstance)` que verifica `typeof ytInstance.unloadModule === "function"` e executa:
     ```javascript
     try {
       ytInstance.unloadModule("captions");
       ytInstance.unloadModule("cc");
     } catch {
       // Ignora caso o vídeo não possua módulo de legenda carregado
     }
     ```
   * Invocar `disableCaptions(player)` tanto no callback `onReady` quanto no callback `onStateChange` sempre que o estado mudar para `YT.PlayerState.PLAYING` ou `YT.PlayerState.CUED`.

#### Justificativa Técnica
* A combinação de `cc_load_policy: 0` com `unloadModule("captions")` e `unloadModule("cc")` na transição para `PLAYING` é o único mecanismo suportado pela YouTube IFrame Player API capaz de suprimir legendas geradas automaticamente (ASR) sem depender de configurações externas da conta Google do usuário.

---

### 3.3 Sistema Global de Favoritos com Ícone Estrela (`★`)

#### Modelo de Dados e Persistência (Backend)
1. **Campo global no `manifest.json`:**
   * Adicionar o atributo booleano `favorite` (padrão `false`) na raiz do `manifest.json` de cada música em cache.
   * Por ser uma marcação global da biblioteca local, todas as sessões e jogadores (`Convidado`, `Willian`, `dany`, etc.) compartilham a mesma lista de músicas favoritas.
2. **API REST (`backend/routes/songs.js`):**
   * Estender o endpoint existente `PATCH /api/songs/:videoId` para aceitar `{ favorite: boolean }` no corpo da requisição, validando que `typeof req.body.favorite === "boolean"` e persistindo via escrita atômica (`atomicJsonStore.js`).
   * Garantir que `GET /api/songs` retorne `favorite: Boolean(manifest.favorite)` em cada item da listagem.

#### Interface e Ordenação (Frontend)
1. **Componente visual do botão de favorito (estrela `★`):**
   * Criar helper reutilizável de UI (construído exclusivamente com `document.createElement` e `textContent`, respeitando a regra de segurança contra `innerHTML`):
     * Estado favoritado (`favorite === true`): ícone `★` em cor dourada (`--color-warning` / `#fbbf24`), `aria-pressed="true"`, `title="Remover dos favoritos"`.
     * Estado normal (`favorite === false`): ícone `☆` discreto, `aria-pressed="false"`, `title="Marcar como favorita"`.
   * Atualização otimista: ao clicar na estrela em qualquer card, o ícone alterna imediatamente na interface e dispara `api.patchSong(videoId, { favorite: nextValue })`. Em caso de falha de rede, reverte o estado visual e exibe banner de aviso.
2. **Ordenação e Filtros (`homeView.js` e `libraryView.js`):**
   * Na seção **"Prontas para cantar agora"** da Tela Inicial (`homeView.js`), músicas com `favorite === true` aparecem no topo da grade, seguidas pelas demais em ordem recente.
   * Na **Biblioteca (`libraryView.js`)**, adicionar um filtro rápido de alternância (**`Todas`** | **`Favoritas ★`**) ao lado do campo de busca e manter as favoritas ordenadas prioritariamente.

#### Justificativa Técnica
* **Por que salvar `favorite` no `manifest.json` em vez de apenas no `localStorage`?** Salvar no `manifest.json` via `PATCH /api/songs/:id` garante que os favoritos sobrevivam à limpeza de cache do navegador, funcionem se o usuário abrir o karaokê em outro navegador da mesma máquina e sejam automaticamente removidos caso a música seja excluída da Biblioteca.

---

### 3.4 Aba "Preparando" no Cabeçalho com Contador Dinâmico

#### Arquitetura de Navegação e Estado
1. **Cabeçalho Principal (`frontend/index.html` e `frontend/src/main.js`):**
   * Adicionar o item de navegação **`Preparando`** logo após **`Biblioteca`** no menu superior:
     * `Início` (`#/`)
     * `Biblioteca` (`#/library`)
     * `Preparando` (`#/prepare`) — acompanhado de um badge contador `<span id="nav-prepare-badge" class="nav-badge" hidden>0</span>` sempre que houver jobs ativos (`queued` ou `running`).
2. **Monitoramento global da fila (`frontend/src/store.js` / `main.js`):**
   * Manter um monitor leve de status dos jobs (`GET /api/jobs`) que atualiza o contador do cabeçalho automaticamente:
     * Intervalo ativo de `2,5 s` enquanto houver pelo menos 1 job em `queued` ou `running` (e `10 s` ou sob demanda quando a fila estiver vazia).
     * Ao detectar que um job mudou de `running` para `ready`, exibe um banner discreto no topo com botão direto **"Cantar agora"**, mesmo que o usuário esteja em outra tela.
3. **Visão consolidada da fila (`frontend/src/views/prepareView.js` e `router.js`):**
   * Suportar tanto a rota direta com ID (`#/prepare/:jobId`) quanto a rota geral da aba (`#/prepare`).
   * Quando acessada pela aba **`Preparando`** (`#/prepare`), exibir:
     * **Em andamento / Na fila:** Lista de músicas sendo baixadas ou processadas pelo worker, mostrando título, posição na fila (`Na fila` vs. `Processando`), etapa atual (`Baixando áudio`, `Separando voz`, `Extraindo melodia`), barra de progresso e botão **Cancelar**.
     * **Recém-concluídas na sessão:** Lista das músicas que acabaram de ficar prontas com botão direto **Cantar** (`#/play/:videoId`) e botão **Buscar mais músicas** (`#/search`).

#### Justificativa Técnica
* Dar visibilidade global à fila no cabeçalho elimina a sensação de "processo perdido em segundo plano" quando o usuário enfileira várias músicas para uma festa e continua navegando ou cantando enquanto o worker processa os próximos itens em FIFO.

---

## 4. Mapeamento Completo de Arquivos Afetados

| Camada | Arquivo | Tipo de Alteração | Resumo Técnico |
| :--- | :--- | :--- | :--- |
| **Backend (API)** | `backend/routes/songs.js` | Modificação | Aceitar e validar `favorite` (booleano) em `PATCH /api/songs/:id` e incluir `favorite` na resposta de `GET /api/songs`. |
| **Backend (Jobs)** | `backend/routes/jobs.js` | Verificação / Ajuste | Garantir que `GET /api/jobs` retorne a lista ordenada de jobs ativos (`running`, `queued`) e recentes com metadados da música (`title`, `video_id`, `progress`, `step`). |
| **Frontend (Shell)** | `frontend/index.html` | Modificação | Incluir link `<a href="#/prepare" data-route="/prepare">Preparando <span id="nav-prepare-badge"></span></a>` no cabeçalho. |
| **Frontend (Core)** | `frontend/src/main.js` | Modificação | Gerenciar o estado ativo da nova aba `Preparando` e o polling adaptativo do contador da fila no cabeçalho. |
| **Frontend (Core)** | `frontend/src/router.js` | Modificação | Registrar a rota `/prepare` (sem parâmetro obrigatório) apontando para `renderPrepareView`. |
| **Frontend (Player)** | `frontend/src/player/youtubePlayer.js` | Modificação | Adicionar `cc_load_policy: 0`, `iv_load_policy: 3` e `unloadModule("captions")` / `unloadModule("cc")` em `onReady` e `onStateChange`. |
| **Frontend (Views)** | `frontend/src/views/playView.js` | Modificação | Ajustar estrutura do palco para ocupar 100% da viewport, centralizar letra e aplicar proporção `16:9` no vídeo de fundo. |
| **Frontend (Views)** | `frontend/src/views/homeView.js` | Modificação | Adicionar ícone estrela (`★`/`☆`) nos cards de músicas prontas e ordenar favoritas no topo. |
| **Frontend (Views)** | `frontend/src/views/libraryView.js` | Modificação | Adicionar ícone estrela (`★`/`☆`), filtro `Favoritas ★` e ordenação prioritária das favoritas. |
| **Frontend (Views)** | `frontend/src/views/prepareView.js` | Modificação | Suportar visualização completa da fila de preparo (`#/prepare`) além do acompanhamento individual (`#/prepare/:jobId`). |
| **Estilos (CSS)** | `frontend/styles/play.css` | Modificação | Implementar layout full-viewport (`100dvh`), centralização vertical das letras, vídeo `16:9` sem distorção e tipografia fluida `clamp()`. |
| **Estilos (CSS)** | `frontend/styles/base.css` e `manage.css` | Modificação | Estilizar o badge contador da aba `Preparando`, o botão de estrela favorita (`★`) e o filtro de favoritas. |
| **Traduções** | `frontend/i18n/pt-BR.json` e `en-US.json` | Modificação | Adicionar chaves de tradução para `nav.prepare`, favoritos e estados da fila de preparo. |
| **Testes** | `scripts/test-search-library.js` / `scripts/test-e2e.js` | Modificação | Adicionar testes automatizados para `PATCH /api/songs/:id` com `favorite: true/false` e listagem da rota `#/prepare`. |

---

## 5. Passo a Passo Técnico de Implementação

A implementação será dividida em **4 etapas incrementais e testáveis**, mantendo os 59 testes atuais funcionando a cada passo:

### Etapa 1 — Backend e Persistência de Favoritos (`songs.js` e `jobs.js`)
1. Inspecionar `backend/routes/songs.js` e `backend/routes/jobs.js`.
2. Atualizar `PATCH /api/songs/:id` para persistir `manifest.favorite = Boolean(req.body.favorite)` usando `atomicJsonStore.js`.
3. Garantir que `GET /api/songs` exponha `favorite: Boolean(manifest.favorite)` em cada música do catálogo.
4. Validar via `node --test` que a persistência e a listagem funcionam sem quebrar o contrato de compatibilidade.

### Etapa 2 — Palco Responsivo (`1080p`/`2K`/`4K`), Vídeo `16:9` e Supressão de Legendas do YouTube
1. Atualizar `frontend/src/player/youtubePlayer.js` com `cc_load_policy: 0`, `iv_load_policy: 3` e descarregamento ativo dos módulos `captions` e `cc`.
2. Atualizar `frontend/styles/play.css` e `frontend/src/views/playView.js`:
   * Converter `#play-shell` para `height: 100dvh; display: flex; flex-direction: column;`.
   * Configurar `.stage-arena` com `flex: 1; min-height: 0;` e centralização vertical/horizontal do bloco `#lyrics-overlay`.
   * Configurar `#yt-player-target` com `aspect-ratio: 16 / 9; height: 100%; width: auto; max-width: 100%; max-height: 100%;` para preencher o máximo possível sem distorção.
   * Aplicar escalas `clamp()` nas fontes das letras e na altura da pista de afinação.

### Etapa 3 — Favoritos Globais (`★`) na Tela Inicial e na Biblioteca
1. Criar módulo utilitário `frontend/src/ui/components/favoriteButton.js` (DOM puro, sem `innerHTML`, com atualização otimista e rollback em erro).
2. Integrar o botão `★` nos cards de `homeView.js` e `libraryView.js`, ordenando favoritas no topo e adicionando o filtro `Favoritas ★` na Biblioteca.
3. Adicionar estilos de destaque dourado para a estrela ativa em `frontend/styles/manage.css`.

### Etapa 4 — Aba "Preparando" no Cabeçalho e Visão Completa da Fila
1. Adicionar o link `Preparando` + badge contador no cabeçalho de `frontend/index.html` e estilizar o badge em `frontend/styles/base.css`.
2. Implementar o monitor leve de jobs em `frontend/src/main.js` para atualizar o badge em tempo real (`Preparando (N)`).
3. Atualizar `frontend/src/router.js` e `frontend/src/views/prepareView.js` para exibir todos os jobs ativos, enfileirados e recém-finalizados na rota `#/prepare`, além de adicionar os testes automatizados correspondentes.

---

## 6. Critérios de Aceitação

1. **Responsividade em 1080p, 2K e 4K:** Na tela de partida (`#/play/:videoId`), não deve haver faixa preta vazia na parte inferior da janela em nenhuma das três resoluções; os controles inferiores ficam ancorados na base e a letra sincronizada permanece centralizada no meio da arena.
2. **Proporção natural do vídeo:** O vídeo de fundo do YouTube preenche a altura disponível da arena mantendo proporção `16:9` (ou natural), sem esticar ou achatar a imagem.
3. **Zero legendas do YouTube:** Vídeos com legendas automáticas habilitadas no YouTube são reproduzidos sem exibir legendas nativas do player por cima da letra do karaokê.
4. **Favoritos globais persistentes:** Clicar na estrela (`★`) de uma música marca-a imediatamente, move-a para o topo da lista e mantém a marcação após recarregar a página ou trocar de perfil de jogador.
5. **Aba Preparando funcional:** Enquanto houver músicas sendo preparadas, o cabeçalho exibe `Preparando (N)` e clicar na aba mostra o progresso e permite cancelar ou iniciar o canto assim que concluir.