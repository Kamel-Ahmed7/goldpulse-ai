# 🔱 GoldPulse AI — Financial Forecasting Web Service

[![Live Demo](https://img.shields.io/badge/Live_Demo-Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://goldpulse-gte0rrqlo-kamel-ahmed7s-projects.vercel.app)
[![Tech Stack](https://img.shields.io/badge/FastAPI-ML_Pipeline-009688?style=for-the-badge&logo=fastapi&logoColor=white)](#tech-stack)

An end-to-end Machine Learning web application predicting physical gold market price trends using historical financial indicators. Built with **FastAPI**, **Ridge Regression**, and a bespoke **Deluxe Musk & Gold UI**.

---

## 🌟 Key Features

- **Real-Time Forecasting Engine**: Leverages Ridge Regression trained on financial indicators for responsive price predictions.
- **Custom Aesthetic**: Bespoke Deluxe Musk & Gold theme designed for a high-end FinTech user experience.
- **Production Architecture**: Decoupled architecture using FastAPI with explicit Pydantic response schemas, comprehensive logging, and robust exception handling.
- **Serverless Ready**: Configured with `@vercel/python` and `@vercel/static` for instant zero-downtime deployment.

---

## 🛠 Tech Stack

- **Machine Learning**: Python, Scikit-Learn (Ridge Regression), Pandas, NumPy, Joblib.
- **Backend API**: FastAPI, Pydantic, Uvicorn.
- **Frontend UI**: Modern HTML5, Custom CSS3 Variables, Asynchronous JavaScript (Fetch API).
- **Deployment**: Vercel Serverless Platform (`vercel.json`).

---

## 📁 Repository Structure

```text
goldpulse-ai/
├── backend/
│   └── app/
│       ├── __init__.py
│       └── main.py              # FastAPI Server & Endpoint Routing
├── data/
│   └── XAU_1d_data.csv          # Historical Gold Price Dataset
├── frontend/
│   ├── index.html               # Main Interface Structure
│   ├── script.js                # Async API Call Logic
│   └── style.css                # Deluxe Musk & Gold Design Palette
├── models/
│   └── gold_price_ridge_model.pkl # Trained Ridge Regression Pipeline
├── requirements.txt             # Python Dependencies
└── vercel.json                  # Serverless Deployment Config
```

---

## 🚀 Local Setup & Installation

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/Kamel-Ahmed7/goldpulse-ai.git](https://github.com/Kamel-Ahmed7/goldpulse-ai.git)
   cd goldpulse-ai
   ```

2. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Run backend server locally:**
   ```bash
   uvicorn backend.app.main:app --reload
   ```

4. Open `frontend/index.html` in your browser or serve via Live Server.

---

## 👤 Author

Developed with passion by **Kamel Ahmed**  
*Front-End & Aspiring Full-Stack / ML Engineer*
