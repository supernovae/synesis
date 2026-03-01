FROM registry.access.redhat.com/ubi9/python-311:1

WORKDIR /opt/app-root/src

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ingestion/app/ ./app/
COPY catalog_schema.py ./app/catalog_schema.py

USER 1001

ENTRYPOINT ["python", "-m", "app.ingest"]
