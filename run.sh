#!/bin/bash

# ==================== 配置区域 ====================
APP_NAME="Stock Monitor"
APP_CMD="node server.js"
LOG_FILE="output.log"
# ==================================================

# 获取正在运行的进程 PID
get_pid() {
    echo $(pgrep -f "$APP_CMD")
}

# 启动服务
start() {
    PID=$(get_pid)
    if [ -n "$PID" ]; then
        echo -e "\033[33m[提示]\033[0m $APP_NAME 已经在运行中 (PID: $PID)"
        exit 0
    fi

    echo -e "\033[32m[启动]\033[0m 正在后台启动 $APP_NAME..."
    # 使用 nohup 启动，并将输出和错误都重定向到 LOG_FILE
    nohup $APP_CMD > $LOG_FILE 2>&1 &

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
        echo -e "\033[33m使用方法:\033[0m $0 {start|stop|check|restart}"
        exit 1
        ;;
esac
