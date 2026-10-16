#!/bin/bash
# cdn-preload.sh  —  对 OSS 上传产物批量提交 CDN 预热/刷新，并轮询直到全部完成

set -euo pipefail

CDN_URLS_IN="${CDN_URLS_IN:-/tmp/cdn-urls-*.txt}"
POLL_INTERVAL="${POLL_INTERVAL:-10}"
POLL_TIMEOUT="${POLL_TIMEOUT:-1800}"
PRELOAD_MIN_BYTES="${PRELOAD_MIN_BYTES:-0}"
CDN_OPERATION="${CDN_OPERATION:-preload}"
CDN_PRELOAD_MAX_ATTEMPTS="${CDN_PRELOAD_MAX_ATTEMPTS:-3}"
CDN_PRELOAD_RETRY_SLEEP="${CDN_PRELOAD_RETRY_SLEEP:-5}"
SIGNATURE_NONCE_USED_SENTINEL="__ZCODE_SIGNATURE_NONCE_USED__"
CDN_DOMAIN_RAW="${CDN_DOMAIN:-cdn-zcode.z.ai}"
CDN_PRELOAD_PROFILE_RAW="${CDN_PRELOAD_PROFILE:-${ALIYUN_CDN_PROFILE:-}}"
CDN_DOMAIN_TARGETS=()
CDN_PRELOAD_PROFILE_TARGETS=()

if ! [[ "$CDN_PRELOAD_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: CDN_PRELOAD_MAX_ATTEMPTS must be a positive integer, got '$CDN_PRELOAD_MAX_ATTEMPTS'"
  exit 1
fi

if ! [[ "$CDN_PRELOAD_RETRY_SLEEP" =~ ^[0-9]+$ ]]; then
  echo "Error: CDN_PRELOAD_RETRY_SLEEP must be a non-negative integer, got '$CDN_PRELOAD_RETRY_SLEEP'"
  exit 1
fi

case "$CDN_OPERATION" in
  preload|refresh)
    ;;
  *)
    echo "Error: CDN_OPERATION must be 'preload' or 'refresh', got '$CDN_OPERATION'"
    exit 1
    ;;
esac

trim_csv_value() {
  echo "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

parse_csv_values() {
  local raw_value="$1"
  local value
  local -a raw_entries=()

  IFS=',' read -r -a raw_entries <<<"$raw_value"
  for raw_entry in "${raw_entries[@]+"${raw_entries[@]}"}"; do
    value="$(trim_csv_value "$raw_entry")"
    [[ -z "$value" ]] && continue
    printf '%s\n' "$value"
  done
}

while IFS= read -r value; do CDN_DOMAIN_TARGETS+=("$value"); done < <(parse_csv_values "$CDN_DOMAIN_RAW")
while IFS= read -r value; do CDN_PRELOAD_PROFILE_TARGETS+=("$value"); done < <(parse_csv_values "$CDN_PRELOAD_PROFILE_RAW")

if [[ ${#CDN_DOMAIN_TARGETS[@]} -eq 0 ]]; then
  echo "Error: CDN_DOMAIN must contain at least one domain" >&2
  exit 1
fi

if [[ ${#CDN_PRELOAD_PROFILE_TARGETS[@]} -ne 0 && ${#CDN_PRELOAD_PROFILE_TARGETS[@]} -ne 1 && ${#CDN_PRELOAD_PROFILE_TARGETS[@]} -ne ${#CDN_DOMAIN_TARGETS[@]} ]]; then
  echo "Error: CDN_PRELOAD_PROFILE must contain one value or match CDN_DOMAIN count (${#CDN_DOMAIN_TARGETS[@]}), got ${#CDN_PRELOAD_PROFILE_TARGETS[@]}" >&2
  exit 1
fi

target_preload_profile_at() {
  local index="$1"
  if [[ ${#CDN_PRELOAD_PROFILE_TARGETS[@]} -eq 0 ]]; then
    echo ""
  elif [[ ${#CDN_PRELOAD_PROFILE_TARGETS[@]} -eq 1 ]]; then
    echo "${CDN_PRELOAD_PROFILE_TARGETS[0]}"
  else
    echo "${CDN_PRELOAD_PROFILE_TARGETS[$index]}"
  fi
}

extract_url_host() {
  local url="$1"
  if [[ "$url" =~ ^https?://([^/:?#]+) ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

resolve_cdn_target_index() {
  local url="$1"
  local host
  local target_index

  if ! host="$(extract_url_host "$url")"; then
    echo "Error: invalid CDN URL, cannot resolve host: $url" >&2
    exit 1
  fi

  for target_index in "${!CDN_DOMAIN_TARGETS[@]}"; do
    if [[ "$host" == "${CDN_DOMAIN_TARGETS[$target_index]}" ]]; then
      echo "$target_index"
      return 0
    fi
  done

  # Bugfix: upload 阶段已经按 CDN_DOMAIN 多账号上传，但 preload 之前统一使用默认 aliyun 账号。
  # 当配置了 per-domain profile 时，未知域名不能回退默认账号，否则会继续触发 “domain does not belong to you”。
  if [[ ${#CDN_PRELOAD_PROFILE_TARGETS[@]} -gt 0 ]]; then
    echo "Error: CDN URL host '$host' is not listed in CDN_DOMAIN; cannot choose preload profile for: $url" >&2
    exit 1
  fi

  echo "0"
}

build_aliyun_profile_args() {
  local target_index="$1"
  local profile

  profile="$(target_preload_profile_at "$target_index")"
  if [[ -n "$profile" ]]; then
    printf '%s\n' "--profile"
    printf '%s\n' "$profile"
  fi
}

run_aliyun_with_retry() {
  local label="$1"
  shift

  local attempt=1
  local stdout_file=""
  local stderr_file=""
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"

  while true; do
    : >"$stdout_file"
    : >"$stderr_file"

    if "$@" >"$stdout_file" 2>"$stderr_file"; then
      cat "$stdout_file"
      rm -f "$stdout_file" "$stderr_file"
      return 0
    fi

    # Bugfix: CDN 预热/刷新提交遇到 EOF 后，阿里云可能已经消费了本次签名 nonce 并创建/接收了请求；
    # 再重放同一请求会返回 SignatureNonceUsed。此时无法拿到 taskId，但继续失败会误杀已触达服务端的任务。
    if [[ "$label" =~ ^aliyun\ cdn\ (PushObjectCache|RefreshObjectCaches)$ ]] && grep -q 'SignatureNonceUsed' "$stderr_file"; then
      echo "Warning: $label returned SignatureNonceUsed; treat CDN request as already submitted." >&2
      cat "$stderr_file" >&2
      echo "$SIGNATURE_NONCE_USED_SENTINEL"
      rm -f "$stdout_file" "$stderr_file"
      return 0
    fi

    # Bugfix: 阿里云 CDN API 偶发在传输层返回 EOF，之前受 set -e 影响会让整条发版预热链路直接失败。
    # 这里仅重试 CLI 调用本身；如果连续失败仍返回原始 stderr，避免吞掉鉴权、配额或参数错误。
    if (( attempt >= CDN_PRELOAD_MAX_ATTEMPTS )); then
      cat "$stderr_file" >&2
      rm -f "$stdout_file" "$stderr_file"
      return 1
    fi

    echo "Warning: retry $label after failed attempt ${attempt}/${CDN_PRELOAD_MAX_ATTEMPTS}" >&2
    cat "$stderr_file" >&2
    ((attempt+=1))
    sleep "$CDN_PRELOAD_RETRY_SLEEP"
  done
}

if [[ ! -f "$CDN_URLS_IN" ]]; then
  files=($CDN_URLS_IN)
  if [[ ${#files[@]} -gt 0 && -f "${files[0]}" ]]; then
    CDN_URL_FILES=("${files[@]}")
    echo "Found ${#CDN_URL_FILES[@]} CDN URL file(s):"
    printf '  - %s\n' "${CDN_URL_FILES[@]}"
  else
    echo "Error: No CDN URL files found (tried: $CDN_URLS_IN)"
    echo "Available files:"
    ls -la cdn-urls*.txt 2>/dev/null || echo "  No cdn-urls*.txt files found"
    exit 1
  fi
else
  CDN_URL_FILES=("$CDN_URLS_IN")
fi

echo "==> Collecting and deduplicating CDN URLs..."
ALL_URL_RECORDS=()

for url_file in "${CDN_URL_FILES[@]}"; do
  echo "Processing URLs from: $url_file"
  while IFS= read -r url_record || [[ -n "$url_record" ]]; do
    [[ -z "$url_record" ]] && continue
    ALL_URL_RECORDS+=("$url_record")
  done < "$url_file"
done

UNIQUE_URL_RECORDS=()
while IFS= read -r url_record; do
  [[ -z "$url_record" ]] && continue
  UNIQUE_URL_RECORDS+=("$url_record")
done < <(
  printf '%s\n' "${ALL_URL_RECORDS[@]}" \
    | awk -F '\t' '
        {
          url = $1
          size = $2
          if (url == "") {
            next
          }

          if (!(url in record_by_url) || (size_by_url[url] !~ /^[0-9]+$/ && size ~ /^[0-9]+$/)) {
            record_by_url[url] = $0
            size_by_url[url] = size
          }
        }

        END {
          for (url in record_by_url) {
            print record_by_url[url]
          }
        }
      ' \
    | sort
)
echo "Total URL records: ${#ALL_URL_RECORDS[@]}, Unique URLs: ${#UNIQUE_URL_RECORDS[@]}"

if [[ ${#UNIQUE_URL_RECORDS[@]} -eq 0 ]]; then
  echo "Error: No URLs found to ${CDN_OPERATION}"
  exit 1
fi

if ! [[ "$PRELOAD_MIN_BYTES" =~ ^[0-9]+$ ]]; then
  echo "Error: PRELOAD_MIN_BYTES must be a non-negative integer, got '$PRELOAD_MIN_BYTES'"
  exit 1
fi

if [[ "$PRELOAD_MIN_BYTES" == "0" ]]; then
  echo "==> Collecting URLs with valid recorded size; no minimum file size threshold is applied..."
else
  echo "==> Filtering URLs by size (recorded file size >= ${PRELOAD_MIN_BYTES} bytes)..."
fi
FILTERED_URLS=()
SKIPPED_URLS=0

parse_preload_record() {
  local url_record="$1"

  PRELOAD_URL=""
  PRELOAD_FILE_SIZE=""
  IFS=$'\t' read -r PRELOAD_URL PRELOAD_FILE_SIZE _ <<< "$url_record"
}

for url_record in "${UNIQUE_URL_RECORDS[@]}"; do
  parse_preload_record "$url_record"

  # Bugfix: 文件真实大小已经在 upload 阶段确定，preload 只消费这份显式映射。
  # 之前缺失 size 时回退到 CDN HEAD，会把“旧格式/异常记录”误当成可预热对象，导致筛选结果和上传清单不一致；
  # 这里统一要求显式 size，缺失就跳过，保证预热行为可预测且与 upload 输出严格一致。
  if ! [[ "$PRELOAD_FILE_SIZE" =~ ^[0-9]+$ ]]; then
    echo "- skip preload (missing/invalid recorded size): $PRELOAD_URL"
    ((SKIPPED_URLS+=1))
    continue
  fi

  # Bugfix: CI 预热默认必须覆盖 upload 清单里的所有有效文件。之前默认 2MB 阈值会跳过小文件，
  # 导致发布后小体积对象仍可能首次访问回源；阈值只保留给人工调试时显式配置。
  if (( PRELOAD_FILE_SIZE < PRELOAD_MIN_BYTES )); then
    echo "- skip preload (${PRELOAD_FILE_SIZE} bytes < ${PRELOAD_MIN_BYTES}): $PRELOAD_URL"
    ((SKIPPED_URLS+=1))
    continue
  fi

  FILTERED_URLS+=("$PRELOAD_URL")
done

echo "Filtered URLs: ${#FILTERED_URLS[@]}, Skipped URLs: ${SKIPPED_URLS}"

if [[ ${#FILTERED_URLS[@]} -eq 0 ]]; then
  echo "No URLs matched ${CDN_OPERATION} criteria. Skip CDN ${CDN_OPERATION}."
  exit 0
fi

if [[ "$CDN_OPERATION" == "refresh" ]]; then
  echo "==> Submitting RefreshObjectCaches tasks..."
else
  echo "==> Submitting PushObjectCache tasks..."
fi
TASK_RECORDS=()
MAYBE_SUBMITTED_COUNT=0
FAILED_SUBMIT_COUNT=0
FAILED_MONITOR_COUNT=0
FAILED_TASK_COUNT=0

for url in "${FILTERED_URLS[@]}"; do
  target_index="$(resolve_cdn_target_index "$url")"
  target_profile="$(target_preload_profile_at "$target_index")"
  aliyun_profile_args=()
  while IFS= read -r aliyun_profile_arg; do
    aliyun_profile_args+=("$aliyun_profile_arg")
  done < <(build_aliyun_profile_args "$target_index")
  # Bugfix: aliyun profile 已承载账号与 endpoint 配置；脚本硬传 region 或 Area 会覆盖
  # profile/域名自身的调度语义，多账号 CDN 迁移时可能把预热/刷新请求打到错误控制面。
  if [[ "$CDN_OPERATION" == "refresh" ]]; then
    if [[ -n "$target_profile" ]]; then
      echo "+ aliyun cdn RefreshObjectCaches --profile \"$target_profile\" --ObjectPath \"$url\" --ObjectType File"
    else
      echo "+ aliyun cdn RefreshObjectCaches --ObjectPath \"$url\" --ObjectType File"
    fi

    if ! cdn_res="$(
      run_aliyun_with_retry "aliyun cdn RefreshObjectCaches" \
        aliyun cdn RefreshObjectCaches \
        ${aliyun_profile_args[@]+"${aliyun_profile_args[@]}"} \
        --ObjectPath "$url" \
        --ObjectType File
    )"; then
      # Bugfix: 旧 stable feed 的 latest*.yml 是同 URL 覆盖，必须刷新边缘缓存才能避免旧包继续命中旧 manifest。
      # CDN 控制面偶发失败仍按 best-effort 处理，避免单个刷新请求阻塞整条发版链路。
      echo "Warning: failed to submit CDN refresh after ${CDN_PRELOAD_MAX_ATTEMPTS} attempt(s), continue: $url" >&2
      ((FAILED_SUBMIT_COUNT+=1))
      continue
    fi
  else
    if [[ -n "$target_profile" ]]; then
      echo "+ aliyun cdn PushObjectCache --profile \"$target_profile\" --ObjectPath \"$url\" --L2Preload true"
    else
      echo "+ aliyun cdn PushObjectCache --ObjectPath \"$url\" --L2Preload true"
    fi

    if ! cdn_res="$(
      run_aliyun_with_retry "aliyun cdn PushObjectCache" \
        aliyun cdn PushObjectCache \
        ${aliyun_profile_args[@]+"${aliyun_profile_args[@]}"} \
        --ObjectPath "$url" \
        --L2Preload true
    )"; then
      # Bugfix: CDN 预热只是发布加速步骤，不应因为阿里云临时错误阻塞后续 publish/release。
      # 提交重试耗尽后记录并跳过当前 URL，保留输入/配置错误仍在前面硬失败。
      echo "Warning: failed to submit CDN preload after ${CDN_PRELOAD_MAX_ATTEMPTS} attempt(s), continue: $url" >&2
      ((FAILED_SUBMIT_COUNT+=1))
      continue
    fi
  fi

  if [[ "$cdn_res" == "$SIGNATURE_NONCE_USED_SENTINEL" ]]; then
    ((MAYBE_SUBMITTED_COUNT+=1))
    continue
  fi

  if [[ "$CDN_OPERATION" == "refresh" ]]; then
    tid="$(echo "$cdn_res" | jq -r '.RefreshTaskId // .RefreshTaskID // .TaskId // empty')"
  else
    tid="$(echo "$cdn_res" | jq -r '.PushTaskId // .PushTaskID // .TaskId // empty')"
  fi

  if [[ -n "$tid" ]]; then
    TASK_RECORDS+=("${target_index}"$'\t'"${tid}")
  fi
done

if [[ ${#TASK_RECORDS[@]} -eq 0 ]]; then
  if [[ "$MAYBE_SUBMITTED_COUNT" -gt 0 ]]; then
    echo "No task IDs returned; ${MAYBE_SUBMITTED_COUNT} CDN ${CDN_OPERATION} request(s) may already be submitted."
    exit 0
  fi
  if [[ "$FAILED_SUBMIT_COUNT" -gt 0 ]]; then
    echo "No tasks submitted. CDN ${CDN_OPERATION} is best-effort; continue release flow. failed_submits=${FAILED_SUBMIT_COUNT}"
    exit 0
  fi
  echo "No tasks submitted."
  exit 0
fi

echo "------------------------------------------"
echo "==> Monitoring ${#TASK_RECORDS[@]} tasks..."

start_time=$(date +%s)
while [[ ${#TASK_RECORDS[@]} -gt 0 ]]; do
  if (( $(date +%s) - start_time > POLL_TIMEOUT )); then
    echo "Warning: CDN ${CDN_OPERATION} monitor timeout reached (${POLL_TIMEOUT}s); continue release flow." >&2
    break
  fi

  still_running=()
  for task_record in "${TASK_RECORDS[@]}"; do
    IFS=$'\t' read -r target_index tid <<< "$task_record"
    target_profile="$(target_preload_profile_at "$target_index")"
    aliyun_profile_args=()
    while IFS= read -r aliyun_profile_arg; do
      aliyun_profile_args+=("$aliyun_profile_arg")
    done < <(build_aliyun_profile_args "$target_index")

    # Bugfix: 查询任务状态必须沿用提交预热时的 profile region，避免查询阶段覆盖 endpoint。
    if [[ -n "$target_profile" ]]; then
      echo "+ aliyun cdn DescribeRefreshTaskById --profile \"$target_profile\" --TaskId \"$tid\""
    else
      echo "+ aliyun cdn DescribeRefreshTaskById --TaskId \"$tid\""
    fi

    if ! res="$(
      run_aliyun_with_retry "aliyun cdn DescribeRefreshTaskById" \
        aliyun cdn DescribeRefreshTaskById \
        ${aliyun_profile_args[@]+"${aliyun_profile_args[@]}"} \
        --TaskId "$tid"
    )"; then
      echo "Warning: failed to query CDN ${CDN_OPERATION} task after ${CDN_PRELOAD_MAX_ATTEMPTS} attempt(s), continue: $tid" >&2
      ((FAILED_MONITOR_COUNT+=1))
      continue
    fi
    status=$(echo "$res" | jq -r '.Tasks[0].Status // "Unknown"')
    process=$(echo "$res" | jq -r '.Tasks[0].Process // "0%"')

    case "$status" in
      "Complete")
        echo "Result: Task $tid finished (100%)."
        ;;
      "Failed")
        echo "Warning: Task $tid FAILED; CDN ${CDN_OPERATION} is best-effort, continue release flow." >&2
        ((FAILED_TASK_COUNT+=1))
        ;;
      *)
        echo "Result: Task $tid is $status ($process)."
        still_running+=("$task_record")
        ;;
    esac
  done

  TASK_RECORDS=("${still_running[@]+"${still_running[@]}"}")
  [[ ${#TASK_RECORDS[@]} -gt 0 ]] && sleep "$POLL_INTERVAL"
done

echo "------------------------------------------"
if [[ "$FAILED_SUBMIT_COUNT" -gt 0 || "$FAILED_MONITOR_COUNT" -gt 0 || "$FAILED_TASK_COUNT" -gt 0 || ${#TASK_RECORDS[@]} -gt 0 ]]; then
  echo "CDN ${CDN_OPERATION} finished best-effort: failed_submits=${FAILED_SUBMIT_COUNT}, failed_queries=${FAILED_MONITOR_COUNT}, failed_tasks=${FAILED_TASK_COUNT}, unfinished_tasks=${#TASK_RECORDS[@]}. Continue release flow."
else
  echo "SUCCESS: All CDN tasks are Complete."
fi
