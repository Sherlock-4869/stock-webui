# 修改总结 / Changes Summary

## 已完成的修改 / Completed Changes

### 1. ✅ 用户授权按钮描述优化 (Authorization Button Description)
**文件**: `public/index.html`
- 修改授权按钮文本从"授予权限"改为"授予问股权限"
- 修改收回按钮文本从"收回授权"改为"收回问股权限"
- 位置: 行 3778, 3817

### 2. ✅ 站点推荐显示修复 (Site Recommendations Display Fix)
**文件**: `public/index.html`
- 在站点推荐菜单上添加了 `onmouseenter` 和 `onmouseleave` 事件
- 这样当鼠标悬停在菜单上时，菜单会保持打开状态
- 位置: 行 496

### 3. ✅ 菜单样式优化 (Menu Styling Optimization)
**文件**: `public/index.html`
- 一级菜单字体从 13px 增大到 14px
- 字体粗细从 600 增加到 700
- 使菜单项更加醒目和易读
- 位置: 行 16

### 4. ✅ AI 问股界面优化 (AI Chat UI Improvements)
**文件**: `public/index.html`

#### 4.1 滚动区域优化
- 将 `.ai-workspace` 改为固定高度 `height: calc(100vh - 150px)` 和最大高度 `max-height: 720px`
- `.ai-chat-pane` 设置为 `height: 100%` 和弹性布局
- `.ai-chat-head` 设置为 `flex: none` 不参与弹性伸缩
- `.ai-messages` 设置为 `flex: 1` 占据剩余空间，添加 `overflow-y: auto` 和 `min-height: 0`
- `.ai-composer` 设置为 `flex: none` 固定在底部
- 现在只有对话区域可以滚动，整个页面不再滚动

#### 4.2 模型选择器
- 在聊天头部添加了模型选择下拉框
- 样式类名: `.ai-chat-model-select`
- 自定义下拉箭头样式，与主题一致
- 位置: 行 646

### 5. ✅ 数据库架构更新 (Database Schema Update)
**文件**: 
- `database/account_schema.sql`
- `database/user_ai_models_migration.sql` (新文件)

#### 新增表: `user_ai_model_configs`
```sql
CREATE TABLE IF NOT EXISTS user_ai_model_configs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  model_name VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_url VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  protocol VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'chat_completions',
  api_key_encrypted TEXT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_ai_model_configs_user (user_id, is_active, id),
  CONSTRAINT fk_user_ai_model_configs_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## 需要进一步实现的功能 / Features Requiring Further Implementation

### AI 模型配置系统 (AI Model Configuration System)

#### 后端需要添加的功能:

1. **数据库方法** (`account/database.js`)
   - `listUserAiModelConfigs(userId)` - 获取用户的AI模型配置列表
   - `getUserAiModelConfig(userId, id)` - 获取单个用户AI模型配置
   - `getActiveUserAiModelConfig(userId)` - 获取用户的活跃模型配置
   - `createUserAiModelConfig(userId, { name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive })` - 创建用户模型配置
   - `updateUserAiModelConfig(userId, id, { name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive })` - 更新用户模型配置
   - `deleteUserAiModelConfig(userId, id)` - 删除用户模型配置
   - `testAiModelConnection(baseUrl, apiKey, modelName)` - 测试AI模型连接

2. **API 路由** (`account/service.js` 或 `ai/service.js`)
   - `GET /api/ai/user-models` - 获取当前用户的模型配置列表
   - `POST /api/ai/user-models` - 创建用户模型配置
   - `PUT /api/ai/user-models/:id` - 更新用户模型配置
   - `DELETE /api/ai/user-models/:id` - 删除用户模型配置
   - `POST /api/ai/user-models/:id/test` - 测试模型连接
   - `POST /api/admin/ai/models/:id/test` - 管理员测试全局模型连接

3. **AI 服务逻辑更新** (`ai/service.js`)
   - 修改 `streamAgent` 方法，优先使用用户配置的模型
   - 如果用户没有配置模型，则使用管理员配置的全局模型
   - 如果两者都没有，返回错误提示用户配置模型

#### 前端需要添加的功能:

1. **用户模型配置页面** (`public/index.html`)
   - 添加一个新的页面 `page-user-ai-models`
   - 显示用户当前的模型配置列表
   - 提供添加、编辑、删除模型配置的表单
   - 每个模型配置项旁边添加"测试连接"按钮

2. **管理员模型管理页面增强**
   - 在现有的 `page-admin-ai` 页面的模型配置表单中添加"测试连接"按钮

3. **AI 问股页面增强**
   - 模型选择器需要从后端加载可用模型列表
   - 包括用户自己配置的模型和管理员配置的全局模型
   - JavaScript 函数需要处理模型选择变化

4. **JavaScript 函数** (需要在 `public/index.html` 中添加)
   ```javascript
   // 用户模型配置管理
   async function loadUserAiModels() { /* 加载用户模型列表 */ }
   async function saveUserAiModel(event) { /* 保存用户模型配置 */ }
   async function deleteUserAiModel(id) { /* 删除用户模型配置 */ }
   async function testAiModelConnection(id, isAdmin) { /* 测试模型连接 */ }
   
   // AI 问股页面
   async function loadAiModelOptions() { /* 加载模型选择器选项 */ }
   function onAiModelSelectChange() { /* 处理模型选择变化 */ }
   ```

## 运行数据库迁移 / Run Database Migration

```bash
# 连接到 MySQL 数据库
mysql -u your_username -p stock < database/user_ai_models_migration.sql
```

## 测试建议 / Testing Recommendations

1. **授权按钮**: 进入"用户与权限"页面，检查按钮文本是否为"授予问股权限"
2. **站点推荐**: 点击站点推荐，确保菜单显示并且鼠标悬停时保持打开
3. **菜单样式**: 检查一级菜单的字体是否更大更粗
4. **AI 聊天滚动**: 发送多条消息，确保只有对话区域滚动
5. **模型选择器**: 检查模型选择框是否显示（需要后端支持后才能正常工作）

## 注意事项 / Notes

1. AI 模型配置系统的完整实现需要更多的后端和前端代码
2. 建议分阶段实现：
   - 第一阶段：完成数据库迁移和基本的 CRUD 操作
   - 第二阶段：添加测试连接功能
   - 第三阶段：在 AI 问股页面集成模型选择
3. 所有 API Key 都使用加密存储，需要配置 `STOCK_AI_CREDENTIAL_ENCRYPTION_KEY` 环境变量
4. 测试连接功能应该验证：
   - Base URL 是否可达
   - API Key 是否有效
   - 模型名称是否存在
