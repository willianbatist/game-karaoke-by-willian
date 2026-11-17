"""
Pacote principal do Worker de IA do Karaokê Local.
Executa download, separação vocal, extração de F0, análise e empacotamento.
"""

CONTRACT_VERSION = 1

# Códigos de saída padronizados (ARCHITECTURE.md §5.3 / CONTRACTS.md §2.2)
EXIT_SUCCESS = 0
EXIT_RETRYABLE_ERROR = 10
EXIT_DEPENDENCY_ERROR = 20
EXIT_DATA_ERROR = 30
EXIT_CANCELED = 130