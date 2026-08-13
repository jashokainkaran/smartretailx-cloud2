# AWS's Lambda base image for Python 3.11. It includes the Lambda Runtime
# Interface Client, which is how AWS invokes our handler.
FROM public.ecr.aws/lambda/python:3.11

# Copy ONLY requirements first, then install — Docker caches this layer, so
# code changes don't trigger a reinstall of every dependency.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# LAMBDA_TASK_ROOT is /var/task — the directory Lambda loads code from.
COPY app/ ${LAMBDA_TASK_ROOT}/app/

# The handler Lambda calls: module path, then function name.
CMD ["app.main.handler"]