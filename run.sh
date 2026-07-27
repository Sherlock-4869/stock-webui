#!/bin/bash

# ==================== 配置区域 ====================
APP_NAME="Stock Monitor"
ENV_FILE="${STOCK_ENV_FILE:-.env}"
LOG_FILE="output.log"
# ==================================================

# 在脚本进程中加载项目配置，不修改系统全局环境变量。
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

# 优先使用项目显式配置或当前 Conda 环境中的 Node，避免 PATH 中旧的
# Node 二进制与服务器 GLIBC 不兼容。
resolve_node_bin() {
    if [ -n "$STOCK_NODE_BIN" ] && [ -x "$STOCK_NODE_BIN" ]; then
        echo "$STOCK_NODE_BIN"
    elif [ -n "$CONDA_PREFIX" ] && [ -x "$CONDA_PREFIX/bin/node" ]; then
        echo "$CONDA_PREFIX/bin/node"
    elif [ -x "$HOME/miniconda3/bin/node" ]; then
        echo "$HOME/miniconda3/bin/node"
    elif [ -x "$HOME/anaconda3/bin/node" ]; then
        echo "$HOME/anaconda3/bin/node"
    else
        command -v node 2>/dev/null
    fi
}

NODE_BIN="$(resolve_node_bin)"
NPM_BIN="${STOCK_NPM_BIN:-}"
if [ -z "$NPM_BIN" ] && [ -n "$NODE_BIN" ]; then
    NPM_BIN="$(dirname "$NODE_BIN")/npm"
fi

# 获取正在运行的进程 PID
get_pid() {
    echo $(pgrep -f "node .*server.js")
}

# 启动服务
start() {
    PID=$(get_pid)
    if [ -n "$PID" ]; then
        echo -e "\033[33m[提示]\033[0m $APP_NAME 已经在运行中 (PID: $PID)"
        exit 0
    fi

    echo -e "\033[32m[启动]\033[0m 正在后台启动 $APP_NAME..."
    if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
        echo -e "\033[31m[错误]\033[0m 找不到可执行的 Node.js，请在 .env 配置 STOCK_NODE_BIN。"
        exit 1
    fi
    if ! NODE_VERSION=$("$NODE_BIN" -v 2>&1); then
        echo -e "\033[31m[错误]\033[0m Node.js 无法运行: $NODE_BIN"
        echo "$NODE_VERSION"
        exit 1
    fi
    echo -e "\033[32m[信息]\033[0m 使用 Node.js: $NODE_BIN ($NODE_VERSION)"
    if [ ! -f "$ENV_FILE" ]; then
        echo -e "\033[33m[提示]\033[0m 未找到 $ENV_FILE，将使用当前进程已有环境变量启动。"
    fi
    nohup "$NODE_BIN" server.js > "$LOG_FILE" 2>&1 &

    sleep 1.5
    PID=$(get_pid)
    if [ -n "$PID" ]; then
        echo -e "\033[32m[成功]\033[0m $APP_NAME 启动成功！"
        echo -e "\033[32m[信息]\033[0m 当前进程 PID: \033[36m$PID\033[0m"
        echo -e "\033[32m[信息]\033[0m 实时日志输出在: \033[35m$LOG_FILE\033[0m (可使用 'tail -f $LOG_FILE' 查看)"
    else
        echo -e "\033[31m[错误]\033[0m $APP_NAME 启动失败，请检查 $LOG_FILE 中的报错日志。"
    fi
}

# 使用与 NODE_BIN 同目录的 npm 安装锁定依赖，避免 npm 的 env node
# shebang 再次命中 PATH 中不兼容的旧 Node。
install_deps() {
    if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
        echo -e "\033[31m[错误]\033[0m 找不到可执行的 Node.js，请在 .env 配置 STOCK_NODE_BIN。"
        exit 1
    fi
    if [ -z "$NPM_BIN" ] || [ ! -x "$NPM_BIN" ]; then
        echo -e "\033[31m[错误]\033[0m 找不到可执行的 npm，请在 .env 配置 STOCK_NPM_BIN。"
        exit 1
    fi
    NODE_DIR="$(dirname "$NODE_BIN")"
    echo -e "\033[32m[安装]\033[0m 使用 $NPM_BIN 安装生产依赖..."
    PATH="$NODE_DIR:$PATH" "$NPM_BIN" ci --omit=dev
}

verify_code() {
    if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ] || [ -z "$NPM_BIN" ] || [ ! -x "$NPM_BIN" ]; then
        echo -e "\033[31m[错误]\033[0m Node.js 或 npm 配置不可用。"
        exit 1
    fi
    NODE_DIR="$(dirname "$NODE_BIN")"
    PATH="$NODE_DIR:$PATH" "$NPM_BIN" run check
    PATH="$NODE_DIR:$PATH" "$NPM_BIN" test
}

# 停止服务
stop() {
    PID=$(get_pid)
    if [ -z "$PID" ]; then
        echo -e "\033[33m[提示]\033[0m 没有发现正在运行的 $APP_NAME 进程。"
        return 0
    fi

    echo -e "\033[31m[停止]\033[0m 正在停止 $APP_NAME (PID: $PID)..."
    kill -15 $PID
    
    # 循环等待，直到进程彻底退出
    for i in {1..5}; do
        sleep 1
        PID=$(get_pid)
        if [ -z "$PID" ]; then
            echo -e "\033[32m[成功]\033[0m 服务已安全停止。"
            return 0
        fi
    done

    # 如果正常信号没有终止成功，强制杀死
    echo -e "\033[33m[警告]\033[0m 进程未响应，正在强制终止 (kill -9)..."
    kill -9 $PID
    sleep 0.5
    echo -e "\033[32m[成功]\033[0m 服务已强制停止。"
}

# 检查状态
check() {
    PID=$(get_pid)
    if [ -n "$PID" ]; then
        echo -e "\033[32m[状态]\033[0m $APP_NAME 正在正常运行 \033[32m●\033[0m"
        echo -e "\033[32m[状态]\033[0m 进程 PID: \033[36m$PID\033[0m"
        # 顺便显示最后 3 行日志，方便看一眼状态
        echo -e "\033[34m[日志]\033[0m 最近运行日志 (最后3行):"
        echo "----------------------------------------"
        tail -n 3 $LOG_FILE 2>/dev/null || echo "(暂无日志内容)"
        echo "----------------------------------------"
    else
        echo -e "\033[31m[状态]\033[0m $APP_NAME 未在运行 \033[31m○\033[0m"
    fi
}

# 重启服务
restart() {
    echo -e "\033[34m[重启]\033[0m 准备重启 $APP_NAME..."
    stop
    sleep 1
    start
}

# 根据传入参数执行对应的函数
case "$1" in
    install)
        install_deps
        ;;
    verify)
        verify_code
        ;;
    start)
        start
        ;;
    stop)
        stop
        ;;
    check)
        check
        ;;
    restart)
        restart
        ;;
    *)
        echo -e "\033[33m使用方法:\033[0m $0 {install|verify|start|stop|check|restart}"
        exit 1
        ;;
esac
