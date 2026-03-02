# Synesis Manager ModelCar Pipeline — download then Buildah build+push.
#
# 1. Download: Python pod pulls model to PVC (~8Gi memory)
# 2. Build+push: Buildah from PVC with 10GB layers, push to ECR, cleanup PVC
#
# Prereq: Create PVC in DS project:
#   oc create -f pipelines/manifests/modelcar-build-pvc.yaml
#   # Edit namespace first, or: sed "s/NAMESPACE/<ds-project>/" pipelines/manifests/modelcar-build-pvc.yaml | oc apply -f -
#
# Compile: python pipelines/manager_modelcar_pipeline.py
# Invoke: ./scripts/run-pipelines.sh manager
# Validate: ./scripts/run-pipelines.sh manager --validate  # 0.5B model, fast end-to-end test

import os

from kfp import dsl
from kfp import kubernetes

_DEFAULT_BUILDER = "123456789012.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry:buildah-ecr"
BUILDAH_ECR_IMAGE = (
    f"{os.environ['ECR_URI']}:buildah-ecr"
    if os.environ.get("ECR_URI")
    else _DEFAULT_BUILDER
)

PVC_MOUNT_PATH = "/data"
_BUILD_MEMORY_LIMIT = "56Gi"


@dsl.component(base_image="python:3.12-slim")
def download_model(model_repo: str):
    """Download HuggingFace model to PVC. Lightweight — ~8Gi memory."""
    import subprocess
    import sys

    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "huggingface_hub[hf_transfer]"],
        check=True,
    )

    import os

    out = "/data/models"
    if os.path.isfile(os.path.join(out, "config.json")):
        print("Model already on PVC, skipping download")
        return
    os.makedirs(out, exist_ok=True)
    from huggingface_hub import snapshot_download

    print("Downloading", model_repo, "->", out)
    snapshot_download(
        repo_id=model_repo,
        local_dir=out,
        token=os.environ.get("HF_TOKEN") or None,
    )
    print("Done")


@dsl.component(base_image="python:3.12-slim")
def build_and_push_modelcar(
    model_name: str,
    ecr_uri: str,
    image_tag: str,
    pvc_name: str,
    buildah_image: str,
):
    """Build ModelCar via a Job with runAsUser:0. Workaround for uid_map in OpenShift."""
    import subprocess
    import sys
    import time

    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kubernetes"], check=True)
    from kubernetes import client, config

    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    core_api = client.CoreV1Api()

    namespace = open("/var/run/secrets/kubernetes.io/serviceaccount/namespace").read().strip()
    job_name = f"modelcar-build-{int(time.time())}"

    env = [
        client.V1EnvVar(name="BUILDAH_ISOLATION", value="chroot"),
        client.V1EnvVar(name="BUILDAH_DRIVER", value="overlay"),
        client.V1EnvVar(name="AWS_ACCESS_KEY_ID", value_from=client.V1EnvVarSource(
            secret_key_ref=client.V1SecretKeySelector(name="aws-ecr-credentials", key="AWS_ACCESS_KEY_ID"),
        )),
        client.V1EnvVar(name="AWS_SECRET_ACCESS_KEY", value_from=client.V1EnvVarSource(
            secret_key_ref=client.V1SecretKeySelector(name="aws-ecr-credentials", key="AWS_SECRET_ACCESS_KEY"),
        )),
    ]
    try:
        core_api.read_namespaced_secret("aws-ecr-session-token", namespace)
        env.append(client.V1EnvVar(name="AWS_SESSION_TOKEN", value_from=client.V1EnvVarSource(
            secret_key_ref=client.V1SecretKeySelector(name="aws-ecr-session-token", key="AWS_SESSION_TOKEN"),
        )))
    except client.exceptions.ApiException:
        pass

    job = client.V1Job(
        metadata=client.V1ObjectMeta(name=job_name, namespace=namespace),
        spec=client.V1JobSpec(
            ttl_seconds_after_finished=300,
            backoff_limit=0,
            template=client.V1PodTemplateSpec(
                metadata=client.V1ObjectMeta(
                    labels={"app": "modelcar-build"},
                ),
                spec=client.V1PodSpec(
                    restart_policy="Never",
                    service_account_name="pipeline-runner-dspa",
                    security_context=client.V1PodSecurityContext(run_as_user=0),
                    containers=[
                        client.V1Container(
                            name="buildah",
                            image=buildah_image,
                            image_pull_policy="Always",
                            security_context=client.V1SecurityContext(
                                run_as_user=0,
                                privileged=True,
                            ),
                            command=["sh", "-c"],
                            args=[
                                "export CONTEXT_DIR=/data && "
                                "exec /usr/local/bin/ecr-login-and-buildah-modelcar-pvc.sh \"$1\" \"$2\" \"$3\"",
                                image_tag,
                                model_name,
                                ecr_uri,
                            ],
                            env=env,
                            volume_mounts=[
                                client.V1VolumeMount(name="pvc", mount_path="/data"),
                                client.V1VolumeMount(name="buildah-storage", mount_path="/var/lib/containers"),
                            ],
                            resources=client.V1ResourceRequirements(
                                requests={"cpu": "2000m", "memory": "16Gi"},
                                limits={"memory": "72Gi"},
                            ),
                        ),
                    ],
                    volumes=[
                        client.V1Volume(
                            name="pvc",
                            persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=pvc_name),
                        ),
                        client.V1Volume(
                            name="buildah-storage",
                            empty_dir=client.V1EmptyDirVolumeSource(size_limit="80Gi"),
                        ),
                    ],
                ),
            ),
        ),
    )

    batch_api = client.BatchV1Api()

    batch_api.create_namespaced_job(namespace=namespace, body=job)
    print(f"Created Job {job_name} in {namespace}")

    # Wait for completion
    while True:
        j = batch_api.read_namespaced_job(name=job_name, namespace=namespace)
        if j.status.succeeded is not None and j.status.succeeded > 0:
            print("Build Job succeeded")
            break
        if j.status.failed is not None and j.status.failed > 0:
            pods = core_api.list_namespaced_pod(
                namespace=namespace,
                label_selector=f"job-name={job_name}",
            )
            for pod in pods.items:
                if pod.status.phase == "Failed":
                    try:
                        logs = core_api.read_namespaced_pod_log(
                            name=pod.metadata.name,
                            namespace=namespace,
                            container="buildah",
                        )
                        print("Build Job failed. Pod logs:\n", logs)
                    except client.exceptions.ApiException as e:
                        print(f"Build Job failed. Could not fetch logs: {e}")
                        print(f"Manually inspect: kubectl logs -n {namespace} {pod.metadata.name} -c buildah")
            raise RuntimeError(f"Build Job failed. Job: {job_name}")
        time.sleep(5)


_BUILD_CONFIG_BAKED = f"{os.environ.get('ECR_URI', '123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models')}::manager::manager"


@dsl.container_component
def build_and_push_modelcar_baked():
    """Build only — ECR URI baked at compile time (resume after failed build)."""
    return dsl.ContainerSpec(
        image=BUILDAH_ECR_IMAGE,
        command=["sh", "-c", f"export CONTEXT_DIR={PVC_MOUNT_PATH} && /usr/local/bin/ecr-login-and-buildah-modelcar-pvc.sh '{_BUILD_CONFIG_BAKED}'"],
    )


@dsl.pipeline(
    name="synesis-manager-modelcar",
    description="Build Manager ModelCar: download to PVC, Buildah build+push to ECR (10GB layers)",
)
def manager_modelcar_pipeline(
    model_repo: str = "nightmedia/Qwen3.5-35B-A3B-Text",
    ecr_uri: str = "123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models",
    image_tag: str = "manager",
    model_name: str = "manager",
    pvc_name: str = "modelcar-build-pvc",
):
    download_task = download_model(model_repo=model_repo)
    kubernetes.mount_pvc(
        download_task,
        pvc_name=pvc_name,
        mount_path=PVC_MOUNT_PATH,
    )
    download_task.set_cpu_request("1000m")
    download_task.set_memory_request("4Gi")
    download_task.set_memory_limit("8Gi")
    kubernetes.use_secret_as_env(
        download_task,
        secret_name="hf-hub-secret",
        secret_key_to_env={"HF_TOKEN": "HF_TOKEN"},
        optional=True,
    )

    build_and_push_task = build_and_push_modelcar(
        model_name=model_name,
        ecr_uri=ecr_uri,
        image_tag=image_tag,
        pvc_name=pvc_name,
        buildah_image=f"{ecr_uri}:buildah-ecr",
    )
    build_and_push_task.after(download_task)


@dsl.pipeline(
    name="synesis-manager-modelcar-build-only",
    description="Build only — model already on PVC (resume after failed build)",
)
def manager_modelcar_pipeline_build_only(
    pvc_name: str = "modelcar-build-pvc",
):
    """Resume: run when download succeeded but build failed."""
    build_task = build_and_push_modelcar_baked()
    kubernetes.mount_pvc(
        build_task,
        pvc_name=pvc_name,
        mount_path=PVC_MOUNT_PATH,
    )
    kubernetes.empty_dir_mount(build_task, volume_name="buildah-storage", mount_path="/var/lib/containers")
    build_task.set_cpu_request("2000m")
    build_task.set_memory_request("8Gi")
    build_task.set_memory_limit(_BUILD_MEMORY_LIMIT)
    kubernetes.set_image_pull_policy(build_task, "Always")
    kubernetes.use_secret_as_env(
        build_task,
        secret_name="aws-ecr-credentials",
        secret_key_to_env={
            "AWS_ACCESS_KEY_ID": "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY": "AWS_SECRET_ACCESS_KEY",
        },
    )
    kubernetes.use_secret_as_env(
        build_task,
        secret_name="aws-ecr-session-token",
        secret_key_to_env={"AWS_SESSION_TOKEN": "AWS_SESSION_TOKEN"},
        optional=True,
    )


if __name__ == "__main__":
    from kfp import compiler

    compiler.Compiler().compile(
        pipeline_func=manager_modelcar_pipeline,
        package_path=__file__.replace(".py", ".yaml"),
    )
    compiler.Compiler().compile(
        pipeline_func=manager_modelcar_pipeline_build_only,
        package_path=__file__.replace(".py", "_build_only.yaml"),
    )
    print("Compiled to manager_modelcar_pipeline.yaml and _build_only.yaml")
