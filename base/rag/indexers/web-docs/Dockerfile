FROM python:3.13-slim

WORKDIR /app

COPY indexers/web-docs/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY indexers/web-docs/app/ /app/app/
COPY ingestion/app/indexer_base.py /app/app/indexer_base.py
COPY catalog_schema.py /app/app/catalog_schema.py
COPY indexers/web-docs/sources.yaml /data/sources.yaml

ENTRYPOINT ["python", "-m", "app.indexer"]
CMD ["--sources", "/data/sources.yaml"]
