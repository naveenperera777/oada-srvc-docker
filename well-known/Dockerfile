FROM oada/node-rdkafka

COPY ./entrypoint.sh /entrypoint.sh
RUN chmod u+x /entrypoint.sh

WORKDIR /code/well-known

CMD /entrypoint.sh
