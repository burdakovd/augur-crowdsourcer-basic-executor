FROM node:8.12

RUN mkdir /src
WORKDIR /src

ADD package.json ./
ADD yarn.lock ./

RUN yarn install

ADD .babelrc ./.babelrc
ADD src ./src

RUN yarn build

ENTRYPOINT yarn start
