FROM python:3.12-slim

RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    fastapi uvicorn pydantic pydantic-settings httpx typer rich \
    prompt-toolkit beautifulsoup4 pyyaml aiosqlite pytest

WORKDIR /workspace
CMD ["bash"]
