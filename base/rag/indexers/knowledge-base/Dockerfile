FROM python:3.13-slim

WORKDIR /app

COPY indexers/knowledge-base/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY indexers/knowledge-base/app/ /app/app/
COPY ingestion/app/indexer_base.py /app/app/indexer_base.py
COPY catalog_schema.py /app/app/catalog_schema.py

# Bundle the curated knowledge-base documents inside the image
COPY knowledge-base/*.md /data/knowledge-base/

ENTRYPOINT ["python", "-m", "app.indexer"]
CMD ["--path", "/data/knowledge-base"]
