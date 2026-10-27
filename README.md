# אפליקציית חובות לקוחות

אפליקציית ווב מותאמת למובייל לניהול חובות לקוחות: לקוחות, פירוט מוצרים וסכומים, תשלומים ויתרה.
שרת Node.js + מסד נתונים PostgreSQL (SQL) על Railway.

## העלאה ל-Railway (פעם אחת)

1. התחברות:
   ```
   railway login
   ```
2. יצירת פרויקט (מתוך התיקייה של האפליקציה):
   ```
   railway init
   ```
3. הוספת מסד נתונים PostgreSQL:
   ```
   railway add --database postgres
   ```
4. העלאת הקוד:
   ```
   railway up
   ```
5. בדשבורד של Railway, בשירות של האפליקציה → **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_PASSWORD` = סיסמה לבחירתך (תתבקש בכניסה לאפליקציה)
6. יצירת כתובת (URL):
   ```
   railway domain
   ```
   מקבלים כתובת כמו `https://xxxx.up.railway.app` — פותחים בטלפון ו"הוסף למסך הבית".

## עדכון אחרי שינויים
```
railway up
```

## הרצה מקומית לבדיקה (בלי מסד נתונים אמיתי, סיסמה 1234)
```
npm install
npm run dev
```
