FROM node:20-alpine AS build
WORKDIR /tmp
ENV NODE_ENV production
ADD package.json /tmp/package.json
RUN npm install 

FROM node:20-alpine
ENV NODE_ENV production
RUN npm install pm2 -g
WORKDIR /home/node/app/
RUN chown -R node:node /home/node/app
COPY --chown=node:node --from=build /tmp/node_modules /home/node/app/node_modules
COPY --chown=node:node . .
USER node

EXPOSE 8080

#CMD ["node","index.js"]
CMD ["pm2-runtime","/home/node/app/index.js","-i max"]

#ENTRYPOINT ["tail", "-f", "/dev/null"]
