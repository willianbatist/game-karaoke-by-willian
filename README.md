# game-karaoke-by-willian

Aplicação web local (`localhost`) de karaokê que transforma músicas do YouTube em faixas jogáveis usando separação vocal por IA local, letras sincronizadas (LRCLIB) e avaliação de afinação em tempo real no navegador.

## Aviso Legal e Escopo de Uso

Este projeto destina-se **exclusivamente a uso pessoal e educacional em ambiente local (`localhost`)**. O download de áudio de plataformas de terceiros e o processamento de obras protegidas por direitos autorais podem violar termos de serviço. **Não distribua nem hospede esta aplicação como serviço público.**

## Requisitos do Ambiente

- **Sistema Operacional:** Linux (incluindo WSL2), macOS ou Windows
- **Node.js:** versão 20 ou superior
- **Python:** versão 3.10 a 3.12 (com suporte a `venv`)
- **Ferramentas externas:** `ffmpeg` e `yt-dlp`
- **Navegador recomendado:** Google Chrome ou Microsoft Edge (Chromium)

## Instalação (Resumo)

1. Configure o ambiente isolado do worker Python (escolhendo o perfil de hardware adequado, como `cpu`, `cuda`, `rocm`, `directml` ou `mps`):
   ```bash
   python3 worker/setup/install.py