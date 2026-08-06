FROM python:3.12-slim

WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    -r requirements.lock.txt && \
    pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -e ".[dev]"

EXPOSE 8000
CMD ["tianshu", "serve", "--port", "8000"]
