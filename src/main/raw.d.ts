// Vite 的 ?raw 匯入（檔案內容當字串）；renderer 由 vite/client 提供，main 的 tsconfig 沒有引入它
declare module '*?raw' {
  const content: string
  export default content
}
