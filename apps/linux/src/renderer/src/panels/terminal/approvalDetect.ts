// 審批偵測已移到 src/shared，main（遠端控制推播）與 renderer 共用同一份規則。
export { stripAnsi, looksLikeApprovalPrompt, readApprovalScreen } from '../../../../shared/approvalDetect'
