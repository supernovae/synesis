FROM python:3.13-slim

WORKDIR /app

COPY indexers/license/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ingestion/app/indexer_base.py /app/ingestion/app/indexer_base.py

COPY indexers/license/app/ /app/app/
COPY indexers/license/sources.yaml /data/sources.yaml
COPY indexers/license/compatibility.yaml /data/compatibility.yaml

ENTRYPOINT ["python", "-m", "app.indexer"]
CMD ["--sources", "/data/sources.yaml", "--compat", "/data/compatibility.yaml"]
