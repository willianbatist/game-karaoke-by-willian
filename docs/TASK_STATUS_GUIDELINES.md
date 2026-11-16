# Diretrizes para Atualização de Status de Tarefas

**Objetivo:** Garantir que todos os agents de IA atualizem o status de tarefas e subtarefas de forma consistente, facilitando o rastreamento de progresso e a coordenação entre equipes.

## Regras de Status
- **Pendente:** Tarefa não iniciada.
- **Em Andamento:** Tarefa foi iniciada, mas não concluída.
- **Completa:** Tarefa foi concluída com sucesso.
- **Bloqueada:** Tarefa não pode prosseguir devido a dependências ou obstáculos.

## Quando Atualizar
1. **Iniciar uma tarefa:** Marque como `Em Andamento` imediatamente após começar.
2. **Concluir uma tarefa:** Marque como `Completa` após verificar que todos os critérios de aceitação foram atendidos.
3. **Bloqueio:** Se houver impedimento, atualize para `Bloqueada` e documente o motivo no campo `Notas de Execução`.

## Exemplo de Estrutura
```markdown
### T0.1 - Exemplo de Tarefa
* **Status:** `[x] COMPLETA`
* **Subtarefas:**
  * `[ ] Subtarefa 1` (pendente)
  * `[x] Subtarefa 2` (completa)
```

**Nota:** Status deve ser atualizado em tempo real. Falhas em seguir essa regra podem causar retrabalho e confusão no fluxo de trabalho.