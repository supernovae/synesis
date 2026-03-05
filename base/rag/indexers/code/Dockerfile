FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY indexers/code/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY indexers/code/app/ /app/app/
COPY ingestion/app/indexer_base.py /app/app/indexer_base.py
COPY catalog_schema.py /app/app/catalog_schema.py
COPY indexers/code/sources.yaml /data/sources.yaml

ENTRYPOINT ["python", "-m", "app.indexer"]
CMD ["--sources", "/data/sources.yaml"]
