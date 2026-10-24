// src/app/router.ts —— 路由（hash 历史：PWA 独立 origin 与 Capacitor 本地加载都稳健，无需服务端重写）。
// 详情页用路由而非弹窗，保证推送深链可直达、系统返回键可用；创建/表单/通知等用覆盖层（见 App.vue 的 host）。
import {installPageNavigation} from '@/app/page-navigation.mjs';
import {restoredRoute} from '@/app/restore-route.mjs';
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useSessionStore } from '@/session/store';
import AppShell from '@/ui/layout/AppShell.vue';
// 手机端页面体量很小，随应用壳一次加载；避免 PWA 升级后旧页面仍在运行、
// 首次点开尚未访问的页面时请求已切换掉的旧版本懒加载文件而出现空白页。
import ConnectView from '@/ui/views/ConnectView.vue';
import AnnouncementsView from '@/ui/views/AnnouncementsView.vue';
import NotificationsView from '@/ui/views/NotificationsView.vue';
import ConversationsView from '@/ui/views/ConversationsView.vue';
import InspirationView from '@/ui/views/InspirationView.vue';
import MemberView from '@/ui/views/MemberView.vue';
import ChatView from '@/ui/views/ChatView.vue';
import SearchView from '@/ui/views/SearchView.vue';
import WorkHomeView from '@/ui/views/WorkHomeView.vue';
import HubDetailView from '@/ui/views/HubDetailView.vue';
import GroupFilesView from '@/ui/views/GroupFilesView.vue';
import FilesView from '@/ui/views/FilesView.vue';
import FeedbackView from '@/ui/views/FeedbackView.vue';
import ProfileView from '@/ui/views/ProfileView.vue';
import CollaborationView from '@/ui/views/CollaborationView.vue';

const routes: RouteRecordRaw[] = [
  { path: '/connect', name: 'connect', component: ConnectView, meta: { public: true } },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', redirect: '/messages' },
      {path:'inspiration',name:'inspiration',component:InspirationView,meta:{title:'个人灵感记录'}},
      {path:'messages',name:'conversations',component:ConversationsView,meta:{title:'消息'}},
      {path:'member/:actor',name:'member',component:MemberView,meta:{title:'成员主页'}},
      { path: 'chat', name: 'chat', component: ChatView, meta: { title: '工作群' } },
      { path: 'collaboration', name: 'collaboration', component: CollaborationView, meta: { title: '协作' } },
      { path: 'inbox', redirect: '/work' },
      { path: 'reviews', redirect: '/work' },
      { path:'search', name:'search', component:SearchView, meta:{title:'查找'} },
      { path: 'work', name: 'work', component: WorkHomeView, meta: { title: '工作' } },
      { path:'work/:id',name:'work-detail',component:HubDetailView,meta:{title:'工作详情'} },
      { path:'material/:id',name:'material-detail',component:HubDetailView,meta:{title:'文件详情'} },
      { path:'group-files',name:'group-files',component:GroupFilesView,meta:{title:'群文件'} },
      { path: 'files', name: 'files', component: FilesView, meta: { title: '文件' } },
      { path: 'personal', name: 'personal', redirect: '/profile' },
      { path: 'company', name: 'company', redirect: '/work' },
      {path:'projects',name:'projects',redirect:'/profile'},
      { path: 'project/:id', name: 'project', redirect: to => ({ name: 'work', query: { project: String(to.params.id) } }) },
      { path: 'issue/:id', name: 'issue', redirect: '/work' },
      { path: 'announcements/:id?', name: 'announcements', component: AnnouncementsView, meta: { title: '公司公告' } },
      { path: 'notifications', name: 'notifications', component: NotificationsView, meta: { title: '消息' } },
      {path:'feedback',name:'feedback',component:FeedbackView,meta:{title:'体验反馈'}},
      { path: 'profile', name: 'profile', component: ProfileView, meta: { title: '我的' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
];

const history = createWebHashHistory();
export const router = createRouter({ history, routes });
export const pageNavigation = installPageNavigation(router, history);

router.beforeEach((to) => {
  const s = useSessionStore();
  const authed = s.isAuthenticated;
  if (!to.meta.public && !authed) {
    // 记录来源，登录/恢复成功后回跳（深链由此保住）
    return { name: 'connect', query: to.fullPath ? { redirect: to.fullPath } : {} };
  }
  if (to.name === 'connect' && authed) return restoredRoute(to.query.redirect);
  return true;
});
