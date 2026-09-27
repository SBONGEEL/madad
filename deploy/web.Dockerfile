# الواجهات الأربع ملفاتٍ ساكنة خلف nginx واحد، و/api إلى الخلفية (نفس الأصل: لا CORS).
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY admin/package.json admin/
COPY customer/package.json customer/
COPY supplier/package.json supplier/
COPY driver/package.json driver/
RUN npm ci
COPY . .
ARG VITE_MAPBOX_TOKEN=""
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
RUN for a in admin customer supplier driver; do (cd $a && npx vite build) || exit 1; done

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/customer/dist /srv/customer
COPY --from=build /src/admin/dist /srv/admin
COPY --from=build /src/supplier/dist /srv/supplier
COPY --from=build /src/driver/dist /srv/driver
