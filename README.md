# naver_menu (Eats Editor)

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Tech Stack
-   **Frontend**: React, Vite, Tailwind CSS
-   **Backend (API)**: Node.js (Vite Middleware for scraping)
-   **AI Integration**: Google Gemini API (Image-to-Image correction)

## Main Features
-   **Naver Place Integration**: Scrape menu images directly from Naver Place URLs.
-   **AI Image Retouching**: Professional food photography enhancement for Coupang Eats.
-   **Parallel Uploading**: Fast batch image uploads to Firebase.

---

### React + Vite Base Documentation

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
