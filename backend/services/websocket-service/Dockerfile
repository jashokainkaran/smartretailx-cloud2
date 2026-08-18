FROM public.ecr.aws/lambda/python:3.11
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ${LAMBDA_TASK_ROOT}/app/
CMD ["app.connect.handler"]
