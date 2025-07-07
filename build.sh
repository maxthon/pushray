source env
NAME="${APP_NAME:=rest_template}"
PORT="${DOCKER_PORT:=8100}"

docker build -t $NAME .
docker container stop $NAME
docker container rm $NAME
docker run --name $NAME --ulimit nofile=90000:90000 -p $PORT:8080 --restart=always \
--log-driver json-file --log-opt max-size=200m --log-opt max-file=3 \
-d $NAME
