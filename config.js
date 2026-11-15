// config.js – THÔNG TIN CẤU HÌNH (sửa file này khi triển khai)
// 1) firebaseConfig: copy từ Firebase Console → Project settings → Your apps → Web app → SDK setup and configuration (Config)
//    Các khóa này được phép công khai; bảo mật dữ liệu nằm ở firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyDnvraTpxEg6bFXt4oO9u8Tfj7TZzFFmuo',
  authDomain: 'lichtruc-hmpxl.firebaseapp.com',
  projectId: 'lichtruc-hmpxl',
  storageBucket: 'lichtruc-hmpxl.firebasestorage.app',
  messagingSenderId: '400342578640',
  appId: '1:400342578640:web:e770e691acbd1b3039f5d5',
};

// 2) URL Web App của Google Apps Script (file mail.gs). Để trống '' = tắt gửi email.
export const MAIL_URL = 'https://script.google.com/macros/s/AKfycbz4tXGjz6OmrJjhQPFu5EZMpJO3WvYVkYmJBETUasWOdehRz9f5Y5sEeTYaWrgMeGww/exec';

// 3) Tên hiển thị
export const APP_TITLE = 'Lịch trực Hoàn Mỹ PXL';
