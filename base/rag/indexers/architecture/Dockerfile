FROM python:3.13-slim

WORKDIR /app

COPY indexers/architecture/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ingestion/app/__init__.py /app/ingestion/app/__init__.py
COPY ingestion/app/indexer_base.py /app/ingestion/app/indexer_base.py

COPY indexers/architecture/app/ /app/app/
COPY indexers/architecture/sources.yaml /data/sources.yaml

ENTRYPOINT ["python", "-m", "app.indexer"]
CMD ["--sources", "/data/sources.yaml"]
