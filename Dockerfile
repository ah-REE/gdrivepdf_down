# GDrive Down backend — API + Playwright browser capture.
# Tuned for small instances (Render free tier: 512 MB).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    GDD_HOST=0.0.0.0 \
    GDD_HEADLESS_ONLY=1 \
    GDD_DEVICE_SCALE=1 \
    GDD_VIEWPORT_H=1400

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && python -m playwright install --with-deps chromium

COPY server.py gdrive_down.py ./
COPY webapp/dist ./webapp/dist

EXPOSE 10000
CMD ["python", "server.py", "--no-browser"]
