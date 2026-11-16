# Plano de Implementação e Controle de Tarefas — Karaokê Local (`localhost`)

**Versão:** 1.1
**Documentos de Referência (Fonte da Verdade):**
* `docs/ARCHITECTURE.md` (v2.2) — Backend, Worker Python, Contratos, Áudio, Pontuação e Segurança local.
* `docs/FRONTEND_ARCHITECTURE.md` (v1.0) — Telas, Navegação, Modos de Jogo, Jogadores e Histórico.
* `docs/CONTRACTS.md` — Formatos concretos (payloads, eventos, manifest, métricas, chaves). Cada item é marcado `[ARQ]` (vem da arquitetura) ou `[DECISÃO]` (lacuna preenchida com a opção mais simples).

Em conflito: arquitetura > `CONTRACTS.md` > este plano.

---

## 1. Painel de Controle e Handoff (Retomada de Sessão)

> **INSTRUÇÃO OBRIGATÓRIA PARA AGENTES DE CÓDIGO:**
> Sempre que iniciar, pausar, interromper ou concluir uma tarefa, atualize (a) o status da tarefa **no arquivo da respectiva fase** (única fonte de verdade dos status) e (b) este painel. Nunca deixe uma tarefa como `EM ANDAMENTO` sem registrar o ponto exato de parada em `Notas de Execução / Handoff`.

* **Fase Atual:** Fase 0 — Fundação, Setup Cross-Platform e Spike do Worker de IA
* **Task / Subtarefa em Execução:** `Nenhuma` (aguardando início da `T0.1`)
* **Próxima Task Recomendada:** `T0.1`
* **Última Atualização / Agente:** Planejamento inicial (revisado)
* **Bloqueios / Alertas de Contexto:** Nenhum. O Spike (`T0.6`) é obrigatório antes da interface e **exige validação humana** (lista de músicas e avaliação auditiva).

---

## 2. Convenções de Status e Regras

### Legenda de Status (usada nos arquivos de fase)
* `[ ] NÃO INICIADA` · `[~] EM ANDAMENTO` · `[x] FINALIZADA` (implementada, testada e validada pelos critérios de aceite) · `[!] BLOQUEADA` (depende de correção externa, decisão ou erro técnico).

### Protocolo de Execução
1. **Seleção:** escolha a próxima task `[ ] NÃO INICIADA` cujas dependências (tabelas abaixo) estejam `[x]`. Marque `[~]` no arquivo da fase. Tasks sem dependência entre si podem ser feitas em qualquer ordem.
2. **Antes de codar:** leia a task inteira, as seções da arquitetura que ela cita e as seções de `CONTRACTS.md` que ela cita. Não precisa ler os documentos inteiros.
3. **Subtarefas:** as tasks maiores já trazem subtarefas (`T<fase>.<task>.<n>`). Em qualquer outra task que se mostre extensa, crie subtarefas na própria seção com o mesmo padrão de status.
4. **Interrupção / troca de agente:** antes de encerrar com trabalho parcial, preencha `Notas de Execução / Handoff` com: arquivos criados/alterados, o que falta e erros pendentes.
5. **Definição de pronto:** os critérios de aceite da task atendidos; testes automatizados da task (quando listados) passando com `npm test` ou `node --test <arquivo>`; nada de arquivo órfão ou código comentado.

### Regras de Escopo e Fidelidade (para não inventar)
* **Implemente apenas o que a task e os documentos descrevem.** Se um detalhe não estiver na task, na arquitetura nem em `CONTRACTS.md`: escolha a opção **mais simples**, registre a decisão/dúvida em `Notas de Execução` e siga. Não crie rotas, campos, telas, opções ou dependências extras.
* **Não implemente o que está fora de escopo** (`CONTRACTS.md` §12): modo Campeonato (só o placeholder), duetos, rede/multiusuário, SQLite, worker residente, saídas de áudio separadas por trilha, contas/autenticação, empacotamento.
* **Segurança:** o app é de uso pessoal em `localhost`. Aplique **somente** as medidas descritas na arquitetura (bind em `127.0.0.1`, `validateVideoId`, proteção contra path traversal, `spawn` com array de argumentos, renderizar nomes/títulos como texto). Não adicione autenticação, CSP, rate limiting, validação de `Host`/`Origin` etc.
* **Limiares e parâmetros** ficam em `config/` (valores marcados "inicial" são ponto de partida), nunca como constantes espalhadas.
* **Se achar erro técnico nos documentos,** sinalize em `Notas de Execução` antes de contornar.
* **Testes automatizados** (`node --test`, arquivos `scripts/test-*.js`) cobrem apenas lógica pura e backend. Telas e áudio/microfone são validados manualmente pelos critérios da task; não simule o navegador.

---

## 3. Visão Geral das Fases e Tarefas

> Os status de cada task ficam **somente** nos arquivos de fase.

### Fase 0 — Fundação, Setup Cross-Platform e Spike do Worker (`docs/tasks/FASE_0_WORKER_SPIKE.md`)
| ID | Tarefa | Dependências |
| :--- | :--- | :--- |
| `T0.1` | Estrutura de diretórios, `config/*.json`, documentos em `docs/` e `README.md` | — |
| `T0.2` | Setup isolado do Worker Python por perfil de acelerador (`venv`) | `T0.1` |
| `T0.3` | Contrato Node ↔ Python v1 (CLI `run` e `doctor --json`, JSON Lines) | `T0.2` |
| `T0.4` | Etapas do pipeline (`download`, `separate`, `pitch`, `analyze`, `package`) | `T0.3` |
| `T0.5` | Scripts operacionais (`scripts/doctor.js`, `update-ytdlp.js`, `lib/venvPaths.js`) | `T0.3` |
| `T0.6` | Spike obrigatório (~20 músicas) e calibração de limiares em `config/` — **exige validação humana** | `T0.4`, `T0.5` |

### Fase 1 — Backend Core e Player Sincronizado (`docs/tasks/FASE_1_BACKEND_PLAYER_CORE.md`)
| ID | Tarefa | Dependências |
| :--- | :--- | :--- |
| `T1.1` | Servidor HTTP Node (`127.0.0.1`), estáticos, `GET /api/config` e guardas de segurança | `T0.1` |
| `T1.2` | `ProcessSupervisor`, `CacheManager` (FLAC/LRU), `JobQueue` (SSE) e worker de teste | `T0.3`, `T0.5`, `T1.1` |
| `T1.3` | `LyricsService` (LRCLIB + normalização) e rotas REST de preparo/cache | `T1.2` |
| `T1.4` | Esqueleto do Frontend sem build (Router, Store, API/SSE, Temas, i18n, banner e confirmação) | `T1.1` |
| `T1.5` | `AudioEngine` (relógio mestre `AudioContext`, stems, `offset_seek`) | `T1.4` |
| `T1.6` | `LyricSync` (`.lrc` + fallbacks) e `YouTubePlayer` (escravo mudo) | `T1.5` |
| `T1.7` | Tela de Jogo v1 (integração básica de áudio, letra e vídeo) | `T0.4`, `T1.3`, `T1.6` |

### Fase 2 — Dispositivos de Áudio e Microfone Amador (`docs/tasks/FASE_2_AUDIO_MICROFONE.md`)
| ID | Tarefa | Dependências |
| :--- | :--- | :--- |
| `T2.1` | Bundle ESM local de `pitchy` em `frontend/vendor/pitchy.js` | `T1.4` |
| `T2.2` | Gerenciador de Dispositivos (`audioDevices.js`, `setSinkId`, hot-plug) | `T1.5` |
| `T2.3` | Cadeia de Captura de Microfone (`micCapture.js` + `pitchWorklet.js`) | `T2.2` |
| `T2.4` | Detector de F0 e Pós-Processamento (`pitchDetector.js`, histerese, vazamento) | `T2.1`, `T2.3` |
| `T2.5` | Calibração Guiada (`micCalibration.js`), Assistente e Configurações de Áudio | `T2.4` |

### Fase 3 — Motor de Pontuação, Pista de Afinação e Resultado (`docs/tasks/FASE_3_PONTUACAO_RESULTADO.md`)
| ID | Tarefa | Dependências |
| :--- | :--- | :--- |
| `T3.1` | `ScoringEngine` (MIDI circular mod 12, dificuldades, heurística, transposição) | `T0.1` |
| `T3.5` | Bateria de testes de pontuação (auto-teste, ruído, oitava, silêncio, latência) — **fazer logo após `T3.1`** | `T3.1` |
| `T3.2` | Pista de Afinação (`pitchLane.js` com dobramento de oitava do cursor) | `T1.5`, `T3.1` |
| `T3.3` | Tela de Jogo Completa (contagem, pausa, atalhos, Wake Lock, avisos) | `T1.7`, `T2.4`, `T3.2` |
| `T3.4` | Tela de Resultado (`result.js`, gráfico temporal, confiança da nota) | `T3.3` |

### Fase 4 — Produto Completo, Compatibilidade, Jogadores e Histórico (`docs/tasks/FASE_4_PRODUTO_HISTORICO.md`)
| ID | Tarefa | Dependências |
| :--- | :--- | :--- |
| `T4.1` | Busca no YouTube (`searchService.js`) e Biblioteca (`library` routes) | `T0.5`, `T1.3` |
| `T4.2` | Serviço de Compatibilidade (`compatibilityService.js` — Fases 1 e 2) | `T0.6`, `T1.2`, `T1.3` |
| `T4.3` | Persistência de Jogadores e Histórico (`playerService`, `historyService`, CSV/TXT) | `T1.1` |
| `T4.4` | Abstração de Modos (`standard` + placeholder `championship`) e Clientes Front | `T3.4`, `T4.3` |
| `T4.5` | Telas de Fluxo Principal (Início, Busca, Preparo SSE, Pré-Jogo) | `T4.1`, `T4.2`, `T4.4` |
| `T4.6` | Telas de Gestão (Biblioteca, Histórico/Rankings, Configurações Completas) | `T2.5`, `T4.5` |
| `T4.7` | Polimento Final, Renderização Segura, Acessibilidade e Validação E2E do MVP | `T4.6` |
