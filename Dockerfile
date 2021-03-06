FROM node:8.12

RUN mkdir /src
WORKDIR /src

ADD package.json ./
ADD yarn.lock ./

RUN yarn install

RUN mkdir /src/config
ADD ./config/config.example.json /src/config/config.json
VOLUME /src/config

ADD .babelrc /src/.babelrc
ADD src /src/src

RUN yarn build

ENTRYPOINT ["yarn", "start"]
CMD []
