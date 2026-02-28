FROM python:3.13-slim

WORKDIR /app

COPY indexers/apispec/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY indexers/apispec/app/ /app/app/
COPY ingestion/app/indexer_base.py /app/app/indexer_base.py
COPY indexers/apispec/sources.yaml /data/sources.yaml

ENTRYPOINT ["python", "-m", "app.indexer"]
CMD ["--sources", "/data/sources.yaml"]
