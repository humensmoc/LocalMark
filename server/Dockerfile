FROM python:3.12-slim
WORKDIR /app
COPY server /app/server
ENV LOCALMARK_HOST=0.0.0.0
ENV LOCALMARK_PORT=8000
ENV LOCALMARK_DB_PATH=/data/localmark.sqlite3
VOLUME ["/data"]
EXPOSE 8000
CMD ["python", "server/app.py"]
