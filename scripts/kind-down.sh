#!/bin/sh
# Deletes the local kind cluster and everything in it. Only ever touches the cluster named "housepot"
# through the repo's own kubeconfig file.
set -eu
cd "$(dirname "$0")/.."
export KUBECONFIG="$PWD/.kube/kind-config"
KIND="$(command -v kind || echo "$PWD/.bin/kind")"
"$KIND" delete cluster --name housepot --kubeconfig "$KUBECONFIG"
