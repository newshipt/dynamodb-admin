FROM mhart/alpine-node:11.10.1

ADD . .

RUN npm install

ENV DYNAMO_ENDPOINT="http://localhost:8000"
ENV AWS_REGION=${AWS_REGION}
ENV AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
ENV AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
ENV NODE_ENV="development"

EXPOSE 8001

CMD ["node", "bin/dynamodb-admin.js"]
