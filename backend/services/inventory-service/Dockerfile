# Start from a slim, official Python image matching our version.
FROM python:3.11-slim

# Where our app lives inside the container.
WORKDIR /app

# Copy ONLY requirements first, then install — this is a caching optimisation.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Now copy the application code.
COPY app/ ./app/

# Document that the service listens on 8080.
EXPOSE 8080

# The command that starts the service when the container runs.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]