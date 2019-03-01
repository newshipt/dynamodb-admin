FROM mhart/alpine-node:8.5.0

ADD . .

RUN npm install

ARG DYNAMO_ENDPOINT="http://localhost:8000"
EXPOSE 8001
CMD ["node", "bin/dynamodb-admin.js"]
