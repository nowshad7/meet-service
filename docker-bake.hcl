variable "UPSTREAM_VERSION" {
  validation {
    condition     = UPSTREAM_VERSION != ""
    error_message = "Set UPSTREAM_VERSION, for example: UPSTREAM_VERSION=$(cat UPSTREAM_VERSION) docker buildx bake"
  }
}

variable "REGISTRY" {
  default = "ghcr.io/nowshad7"
}

variable "TAGS" {
  default = "dev"
}

variable "SOURCE_URL" {
  default = "https://github.com/nowshad7/meet-service"
}

group "default" {
  targets = ["meet", "stt-gateway"]
}

target "meet" {
  name       = "${service}"
  matrix     = { service = ["prosody", "web", "jicofo", "jvb", "jibri", "app-proxy"] }
  context    = "."
  dockerfile = "images/Dockerfile"
  target     = service
  args       = { UPSTREAM_VERSION = UPSTREAM_VERSION }
  tags       = [for tag in split(",", TAGS) : "${REGISTRY}/meet-${service}:${tag}"]
  labels = {
    "org.opencontainers.image.title"     = "meet-${service}"
    "org.opencontainers.image.source"    = SOURCE_URL
    "org.opencontainers.image.version"   = element(split(",", TAGS), 0)
    "org.opencontainers.image.licenses"  = "Apache-2.0"
    "org.opencontainers.image.base.name" = service == "app-proxy" ? "docker.io/library/nginx:alpine" : "ghcr.io/jitsi/${service}:${UPSTREAM_VERSION}"
  }
}


target "stt-gateway" {
  context = "."
  dockerfile = "services/stt-gateway/Dockerfile"
  tags = [for tag in split(",", TAGS) : "${REGISTRY}/meet-stt-gateway:${tag}"]
  labels = {
    "org.opencontainers.image.source" = SOURCE_URL
    "org.opencontainers.image.licenses" = "Apache-2.0"
  }
}
