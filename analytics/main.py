"""
Analytics Service — Sistema de Asistencia
FastAPI + Pandas para reportes complejos y exportación
"""

import os
import secrets
from datetime import date, timedelta
from typing import Optional
from io import BytesIO

import pandas as pd
from fastapi import FastAPI, Depends, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()

# ─── DB ──────────────────────────────────────────────────────────
DB_URL = (
    f"mysql+pymysql://{os.getenv('DB_USER','asistencia_user')}:"
    f"{os.getenv('DB_PASSWORD','asistencia_pass')}@"
    f"{os.getenv('DB_HOST','localhost')}:{os.getenv('DB_PORT','3306')}/"
    f"{os.getenv('DB_NAME','asistencia')}?charset=utf8mb4"
)
engine = create_engine(DB_URL, pool_pre_ping=True, pool_recycle=3600)

# ─── App ──────────────────────────────────────────────────────────
app = FastAPI(title="Analytics Service — Asistencia", version="1.0.0")

# CORS: restringir a orígenes conocidos (configurable vía ALLOWED_ORIGINS, CSV)
_default_origins = "http://sishoras.saa.com.py,https://sishoras.saa.com.py,http://localhost:3000"
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", _default_origins).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key"],
)

# Sin default inseguro: si API_KEY no está configurada, el servicio rechaza
# todas las peticiones autenticadas (fail-closed) en vez de aceptar una clave
# conocida por defecto.
API_KEY = os.getenv("API_KEY")
if not API_KEY:
    import logging
    logging.getLogger("uvicorn.error").warning(
        "API_KEY no configurada: los endpoints protegidos rechazarán todas las peticiones."
    )

def verify_key(
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    api_key: Optional[str] = Query(None),
):
    # Preferir el header; el query string se mantiene por compatibilidad pero
    # queda registrado en logs de acceso, por lo que debe migrarse al header.
    provided = x_api_key or api_key
    if not API_KEY or not provided or not secrets.compare_digest(provided, API_KEY):
        raise HTTPException(status_code=401, detail="Clave inválida")
    return provided


# ─── Helpers ──────────────────────────────────────────────────────
def query_df(sql: str, params: dict = {}) -> pd.DataFrame:
    with engine.connect() as conn:
        return pd.read_sql(text(sql), conn, params=params)


def minutes_to_hm(minutes) -> str:
    """Convertir minutos a formato h:mm"""
    if pd.isna(minutes) or minutes == 0:
        return "0:00"
    h, m = divmod(int(minutes), 60)
    return f"{h}:{m:02d}"


# ─── Endpoints ────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/reports/daily")
def daily_report(
    report_date: Optional[date] = Query(default=None),
    dept_id: Optional[int] = None,
    _=Depends(verify_key)
):
    """Reporte de asistencia diaria"""
    if not report_date:
        report_date = date.today()

    sql = """
        SELECT
            e.code, e.employee_number,
            CONCAT(e.first_name,' ',e.last_name) AS employee_name,
            d.name AS department, s.name AS schedule,
            s.check_in AS scheduled_in, s.check_out AS scheduled_out,
            ds.first_in, ds.last_out, ds.worked_minutes,
            ds.late_minutes, ds.status
        FROM employees e
        LEFT JOIN departments d  ON e.department_id = d.id
        LEFT JOIN schedules   s  ON e.schedule_id   = s.id
        LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date = :report_date
        WHERE e.status = 'active'
        {dept_filter}
        ORDER BY d.name, e.last_name, e.first_name
    """.format(dept_filter="AND e.department_id = :dept_id" if dept_id else "")

    params = {"report_date": str(report_date)}
    if dept_id:
        params["dept_id"] = dept_id

    df = query_df(sql, params)
    df["worked_hm"]   = df["worked_minutes"].apply(minutes_to_hm)
    df["late_hm"]     = df["late_minutes"].apply(minutes_to_hm)

    summary = {
        "date":        str(report_date),
        "total":       len(df),
        "present":     int((df["status"] == "present").sum()),
        "late":        int((df["status"] == "late").sum()),
        "absent":      int((df["status"] == "absent").sum() + df["status"].isna().sum()),
        "on_permission": int((df["status"] == "permission").sum()),
    }

    return {"summary": summary, "data": df.to_dict(orient="records")}


@app.get("/reports/monthly")
def monthly_report(
    year: int = Query(default=date.today().year),
    month: int = Query(default=date.today().month),
    dept_id: Optional[int] = None,
    _=Depends(verify_key)
):
    """Reporte mensual consolidado por empleado"""
    date_from = date(year, month, 1)
    # Último día del mes
    if month == 12:
        date_to = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        date_to = date(year, month + 1, 1) - timedelta(days=1)

    dept_filter = "AND e.department_id = :dept_id" if dept_id else ""

    sql = f"""
        SELECT
            e.code, e.employee_number,
            CONCAT(e.first_name,' ',e.last_name) AS employee_name,
            d.name AS department,
            COUNT(CASE WHEN ds.status IN ('present','late') THEN 1 END) AS days_present,
            COUNT(CASE WHEN ds.status = 'late'              THEN 1 END) AS days_late,
            COUNT(CASE WHEN ds.status = 'absent'            THEN 1 END) AS days_absent,
            COUNT(CASE WHEN ds.status = 'permission'        THEN 1 END) AS days_permission,
            COALESCE(SUM(ds.worked_minutes), 0)   AS total_worked_minutes,
            COALESCE(SUM(ds.late_minutes), 0)     AS total_late_minutes,
            COALESCE(SUM(ds.overtime_minutes), 0) AS total_overtime_minutes
        FROM employees e
        LEFT JOIN departments d ON e.department_id = d.id
        LEFT JOIN daily_summary ds ON e.id = ds.employee_id
            AND ds.date BETWEEN :date_from AND :date_to
        WHERE e.status = 'active' {dept_filter}
        GROUP BY e.id, e.code, e.employee_number, e.first_name, e.last_name, d.name
        ORDER BY d.name, e.last_name
    """
    params = {"date_from": str(date_from), "date_to": str(date_to)}
    if dept_id:
        params["dept_id"] = dept_id

    df = query_df(sql, params)
    df["total_worked_hm"]   = df["total_worked_minutes"].apply(minutes_to_hm)
    df["total_late_hm"]     = df["total_late_minutes"].apply(minutes_to_hm)
    df["total_overtime_hm"] = df["total_overtime_minutes"].apply(minutes_to_hm)

    return {
        "period": {"year": year, "month": month, "from": str(date_from), "to": str(date_to)},
        "total_employees": len(df),
        "data": df.to_dict(orient="records")
    }


@app.get("/reports/export/excel")
def export_excel(
    report_type: str = Query(..., description="daily | monthly | weekly"),
    year: int = Query(default=date.today().year),
    month: int = Query(default=date.today().month),
    report_date: Optional[date] = None,
    dept_id: Optional[int] = None,
    _=Depends(verify_key)
):
    """Exportar reporte a Excel (.xlsx)"""

    if report_type == "daily":
        result = daily_report(report_date=report_date or date.today(), dept_id=dept_id, _=_)
        df = pd.DataFrame(result["data"])
        sheet_name = f"Asistencia {result['summary']['date']}"
    elif report_type == "monthly":
        result = monthly_report(year=year, month=month, dept_id=dept_id, _=_)
        df = pd.DataFrame(result["data"])
        sheet_name = f"Mes {month:02d}-{year}"
    else:
        raise HTTPException(status_code=400, detail="report_type debe ser daily o monthly")

    # Crear Excel en memoria
    output = BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name=sheet_name)

        # Ajustar anchos de columna
        worksheet = writer.sheets[sheet_name]
        for col in worksheet.columns:
            max_len = max(len(str(cell.value or "")) for cell in col) + 4
            worksheet.column_dimensions[col[0].column_letter].width = min(max_len, 40)

    output.seek(0)
    filename = f"reporte_{report_type}_{year}-{month:02d}.xlsx"

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@app.get("/reports/dashboard-kpis")
def dashboard_kpis(_=Depends(verify_key)):
    """KPIs para el dashboard principal"""
    today = date.today()
    month_start = date(today.year, today.month, 1)

    # Hoy
    today_sql = """
        SELECT
            SUM(ds.status IN ('present','late')) AS present_today,
            SUM(ds.status = 'late')              AS late_today,
            SUM(ds.status = 'absent' OR ds.status IS NULL) AS absent_today,
            COUNT(e.id)                          AS total_active
        FROM employees e
        LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date = :today
        WHERE e.status = 'active'
    """
    # Mes actual
    month_sql = """
        SELECT
            AVG(ds.late_minutes)    AS avg_late_minutes,
            SUM(ds.overtime_minutes) AS total_overtime,
            SUM(ds.status = 'absent') AS total_absences
        FROM daily_summary ds
        JOIN employees e ON ds.employee_id = e.id
        WHERE e.status = 'active' AND ds.date BETWEEN :month_start AND :today
    """

    today_df = query_df(today_sql, {"today": str(today)})
    month_df = query_df(month_sql, {"month_start": str(month_start), "today": str(today)})

    return {
        "today": today_df.to_dict(orient="records")[0],
        "month": month_df.to_dict(orient="records")[0],
        "date": str(today)
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=5000, reload=False)
