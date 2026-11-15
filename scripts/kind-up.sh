#!/bin/sh
# Brings the whole app up on a local Kubernetes cluster (kind = Kubernetes in Docker).
# Needs Docker running and kubectl installed. Open http://localhost:8642 when it finishes.
#
# Safety: this script only ever talks to its own cluster, through its own kubeconfig file in
# .kube/kind-config. It never reads or changes ~/.kube/config, so it cannot touch any other cluster.
set -eu
cd "$(dirname "$0")/.."
ROOT="$PWD"

export KUBECONFIG="$ROOT/.kube/kind-config"
CLUSTER=housepot
KIND_VERSION=v0.33.0
mkdir -p "$ROOT/.kube" "$ROOT/.bin"

# kubectl wrapper that always names the local kubeconfig explicitly.
k() { kubectl --kubeconfig "$KUBECONFIG" "$@"; }

KIND="$(command -v kind || true)"
if [ -z "$KIND" ]; then
  KIND="$ROOT/.bin/kind"
  if [ ! -x "$KIND" ]; then
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"
    case "$ARCH" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; esac
    URL="https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-$OS-$ARCH"
    echo "Downloading kind $KIND_VERSION into .bin/ (about 10 MB)…"
    curl -fsSL -o "$KIND" "$URL"
    # Check the download against the checksum published next to it.
    WANT="$(curl -fsSL "$URL.sha256sum" | cut -d' ' -f1)"
    GOT="$(shasum -a 256 "$KIND" | cut -d' ' -f1)"
    if [ "$WANT" != "$GOT" ]; then
      rm -f "$KIND"
      echo "Checksum mismatch for kind; download removed." >&2
      exit 1
    fi
    chmod +x "$KIND"
  fi
fi

if ! "$KIND" get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  "$KIND" create cluster --config k8s/overlays/local/kind-config.yaml --kubeconfig "$KUBECONFIG"
else
  "$KIND" export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG"
fi

echo "Building the image…"
docker build -t housepot:dev .
"$KIND" load docker-image housepot:dev --name "$CLUSTER"

echo "Applying the local overlay…"
k apply -k k8s/overlays/local
# Pick up a rebuilt image that has the same tag.
k -n housepot rollout restart deployment/web >/dev/null
k -n housepot rollout status statefulset/postgres --timeout=180s
k -n housepot rollout status deployment/minio --timeout=180s
k -n housepot rollout status deployment/web --timeout=240s

echo
echo "Housepot is running at http://localhost:8642"
echo "Texts are faked: read them at http://localhost:8642/dev/outbox"
echo "Look around:  kubectl --kubeconfig .kube/kind-config -n housepot get all"
echo "Tear down:    sh scripts/kind-down.sh"
