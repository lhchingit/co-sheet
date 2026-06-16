// @ts-check
/*
 * sheet-functions.js
 * -----------------------------------------------------------------------------
 * Reference catalog of spreadsheet functions used to power the formula-bar
 * autocomplete (the dropdown that appears when a user types "=" followed by
 * letters). This is a TYPING AID only: it lists the standard Google Sheets
 * function names with short bilingual (zh-Hant / en) descriptions so users can
 * discover and insert function names quickly.
 *
 * IMPORTANT: Listing a function here does NOT mean this app's formula engine can
 * evaluate it. The engine in app.js currently computes SUM(range),
 * AVERAGE(range) and basic two-operand arithmetic; other functions will return
 * "#ERR!" if entered. The catalog mirrors the Google Sheets function list
 * (https://support.google.com/docs/answer/3092991) purely as a name reference.
 *
 * Each entry: { n: <NAME>, zh: <Traditional Chinese desc>, en: <English desc> }
 * Exposed on the global scope as window.SHEET_FUNCTIONS (consumed by app.js).
 */
(function () {
  const FN = [
    // --- Math -------------------------------------------------------------
    { n: 'ABS', zh: '傳回數字的絕對值。', en: 'Returns the absolute value of a number.' },
    { n: 'ACOS', zh: '傳回數值的反餘弦值，以弧度表示。', en: 'Returns the inverse cosine of a value, in radians.' },
    { n: 'ACOSH', zh: '傳回數字的反雙曲餘弦值。', en: 'Returns the inverse hyperbolic cosine of a number.' },
    { n: 'ASIN', zh: '傳回數值的反正弦值，以弧度表示。', en: 'Returns the inverse sine of a value, in radians.' },
    { n: 'ASINH', zh: '傳回數字的反雙曲正弦值。', en: 'Returns the inverse hyperbolic sine of a number.' },
    { n: 'ATAN', zh: '傳回數值的反正切值，以弧度表示。', en: 'Returns the inverse tangent of a value, in radians.' },
    { n: 'ATAN2', zh: '依據 (x, y) 座標傳回角度，以弧度表示。', en: 'Returns the angle (in radians) from the x-axis to a point (x, y).' },
    { n: 'ATANH', zh: '傳回數字的反雙曲正切值。', en: 'Returns the inverse hyperbolic tangent of a number.' },
    { n: 'CEILING', zh: '將數字無條件進位至最接近的指定倍數。', en: 'Rounds a number up to the nearest multiple of a factor.' },
    { n: 'COS', zh: '傳回角度的餘弦值（以弧度表示）。', en: 'Returns the cosine of an angle in radians.' },
    { n: 'COSH', zh: '傳回數字的雙曲餘弦值。', en: 'Returns the hyperbolic cosine of a number.' },
    { n: 'COUNTBLANK', zh: '計算指定範圍內空白儲存格的數量。', en: 'Counts the number of empty cells in a range.' },
    { n: 'COUNTIF', zh: '計算範圍內符合單一條件的儲存格數量。', en: 'Counts cells in a range that meet a single criterion.' },
    { n: 'COUNTIFS', zh: '計算範圍內符合多項條件的儲存格數量。', en: 'Counts cells across ranges meeting multiple criteria.' },
    { n: 'DEGREES', zh: '將弧度值轉換為角度值。', en: 'Converts an angle from radians to degrees.' },
    { n: 'EXP', zh: '傳回 e 的指定次方值。', en: 'Returns Euler\'s number e raised to a power.' },
    { n: 'FACT', zh: '傳回數字的階乘。', en: 'Returns the factorial of a number.' },
    { n: 'FLOOR', zh: '將數字無條件捨去至最接近的指定倍數。', en: 'Rounds a number down to the nearest multiple of a factor.' },
    { n: 'GCD', zh: '傳回一或多個整數的最大公因數。', en: 'Returns the greatest common divisor of integers.' },
    { n: 'INT', zh: '將數字無條件捨去為最接近的整數。', en: 'Rounds a number down to the nearest integer.' },
    { n: 'LCM', zh: '傳回一或多個整數的最小公倍數。', en: 'Returns the least common multiple of integers.' },
    { n: 'LN', zh: '傳回數字以 e 為底的對數。', en: 'Returns the natural logarithm of a number (base e).' },
    { n: 'LOG', zh: '傳回數字在指定底數下的對數。', en: 'Returns the logarithm of a number to a given base.' },
    { n: 'LOG10', zh: '傳回數字以 10 為底的對數。', en: 'Returns the base-10 logarithm of a number.' },
    { n: 'MOD', zh: '傳回兩數相除後的餘數。', en: 'Returns the remainder of a division.' },
    { n: 'MROUND', zh: '將數字四捨五入至最接近的指定倍數。', en: 'Rounds a number to the nearest multiple of a factor.' },
    { n: 'PI', zh: '傳回圓周率 π 的值。', en: 'Returns the value of pi.' },
    { n: 'POWER', zh: '傳回數字的指定次方值。', en: 'Returns a number raised to a power.' },
    { n: 'PRODUCT', zh: '傳回一系列數字的乘積。', en: 'Returns the product of a series of numbers.' },
    { n: 'QUOTIENT', zh: '傳回兩數相除後的整數部分。', en: 'Returns the integer result of a division.' },
    { n: 'RADIANS', zh: '將角度值轉換為弧度值。', en: 'Converts an angle from degrees to radians.' },
    { n: 'RAND', zh: '傳回 0 到 1 之間的隨機數字。', en: 'Returns a random number between 0 and 1.' },
    { n: 'RANDBETWEEN', zh: '傳回兩個指定數字之間的隨機整數。', en: 'Returns a random integer between two values.' },
    { n: 'ROUND', zh: '依指定的小數位數對數字四捨五入。', en: 'Rounds a number to a specified number of decimal places.' },
    { n: 'ROUNDDOWN', zh: '依指定的位數將數字無條件捨去。', en: 'Rounds a number down to a number of digits.' },
    { n: 'ROUNDUP', zh: '依指定的位數將數字無條件進位。', en: 'Rounds a number up to a number of digits.' },
    { n: 'SIGN', zh: '傳回數字的正負號（-1、0 或 1）。', en: 'Returns the sign of a number (-1, 0 or 1).' },
    { n: 'SIN', zh: '傳回角度的正弦值（以弧度表示）。', en: 'Returns the sine of an angle in radians.' },
    { n: 'SINH', zh: '傳回數字的雙曲正弦值。', en: 'Returns the hyperbolic sine of a number.' },
    { n: 'SQRT', zh: '傳回正數的正平方根。', en: 'Returns the positive square root of a number.' },
    { n: 'SUM', zh: '傳回一系列數字或儲存格的總和。', en: 'Returns the sum of a series of numbers or cells.' },
    { n: 'SUMIF', zh: '加總範圍內符合單一條件的數值。', en: 'Sums values in a range that meet a single criterion.' },
    { n: 'SUMIFS', zh: '加總範圍內符合多項條件的數值。', en: 'Sums values that meet multiple criteria.' },
    { n: 'SUMPRODUCT', zh: '傳回對應陣列或範圍乘積的總和。', en: 'Returns the sum of products of corresponding ranges.' },
    { n: 'SUMSQ', zh: '傳回一系列數字平方和。', en: 'Returns the sum of the squares of a series of numbers.' },
    { n: 'TAN', zh: '傳回角度的正切值（以弧度表示）。', en: 'Returns the tangent of an angle in radians.' },
    { n: 'TANH', zh: '傳回數字的雙曲正切值。', en: 'Returns the hyperbolic tangent of a number.' },
    { n: 'TRUNC', zh: '將數字截斷至指定的小數位數。', en: 'Truncates a number to a number of decimal places.' },

    // --- Statistical ------------------------------------------------------
    { n: 'AVERAGE', zh: '傳回一系列數字或儲存格的平均值。', en: 'Returns the average of a series of numbers or cells.' },
    { n: 'AVERAGEA', zh: '傳回數值資料集的平均值（含文字視為 0）。', en: 'Returns the numerical average, treating text as 0.' },
    { n: 'AVERAGEIF', zh: '傳回範圍內符合條件的平均值。', en: 'Returns the average of values meeting a criterion.' },
    { n: 'AVERAGEIFS', zh: '傳回範圍內符合多項條件的平均值。', en: 'Returns the average of values meeting multiple criteria.' },
    { n: 'COUNT', zh: '計算資料集中數值項目的數量。', en: 'Counts the number of numeric values in a dataset.' },
    { n: 'COUNTA', zh: '計算資料集中非空白項目的數量。', en: 'Counts the number of non-empty values in a dataset.' },
    { n: 'CORREL', zh: '傳回兩組資料的相關係數。', en: 'Returns the correlation coefficient of two datasets.' },
    { n: 'FREQUENCY', zh: '計算數值落在各區間的次數分配。', en: 'Calculates the frequency distribution across intervals.' },
    { n: 'LARGE', zh: '傳回資料集中第 n 大的值。', en: 'Returns the nth largest element in a dataset.' },
    { n: 'MAX', zh: '傳回資料集中的最大值。', en: 'Returns the maximum value in a dataset.' },
    { n: 'MAXIFS', zh: '傳回符合多項條件的最大值。', en: 'Returns the maximum value meeting multiple criteria.' },
    { n: 'MEDIAN', zh: '傳回資料集的中位數。', en: 'Returns the median value in a dataset.' },
    { n: 'MIN', zh: '傳回資料集中的最小值。', en: 'Returns the minimum value in a dataset.' },
    { n: 'MINIFS', zh: '傳回符合多項條件的最小值。', en: 'Returns the minimum value meeting multiple criteria.' },
    { n: 'MODE', zh: '傳回資料集中出現次數最多的值。', en: 'Returns the most common value in a dataset.' },
    { n: 'PERCENTILE', zh: '傳回資料集中指定百分位數的值。', en: 'Returns the value at a given percentile of a dataset.' },
    { n: 'QUARTILE', zh: '傳回資料集中指定四分位數的值。', en: 'Returns a value at a given quartile of a dataset.' },
    { n: 'RANK', zh: '傳回某數值在資料集中的排名。', en: 'Returns the rank of a value within a dataset.' },
    { n: 'SMALL', zh: '傳回資料集中第 n 小的值。', en: 'Returns the nth smallest element in a dataset.' },
    { n: 'STDEV', zh: '依樣本估算標準差。', en: 'Estimates standard deviation based on a sample.' },
    { n: 'STDEVP', zh: '依整個母體計算標準差。', en: 'Calculates standard deviation of an entire population.' },
    { n: 'VAR', zh: '依樣本估算變異數。', en: 'Estimates variance based on a sample.' },
    { n: 'VARP', zh: '依整個母體計算變異數。', en: 'Calculates variance of an entire population.' },

    // --- Logical ----------------------------------------------------------
    { n: 'AND', zh: '若所有引數皆為 TRUE 則傳回 TRUE。', en: 'Returns TRUE if all arguments are TRUE.' },
    { n: 'FALSE', zh: '傳回邏輯值 FALSE。', en: 'Returns the logical value FALSE.' },
    { n: 'IF', zh: '依條件成立與否傳回不同的值。', en: 'Returns one value if a condition is true, another if false.' },
    { n: 'IFERROR', zh: '若公式發生錯誤則傳回指定值。', en: 'Returns a value if a formula results in an error.' },
    { n: 'IFNA', zh: '若公式回傳 #N/A 錯誤則傳回指定值。', en: 'Returns a value if a formula returns #N/A.' },
    { n: 'IFS', zh: '檢查多項條件並傳回第一個成立者的值。', en: 'Evaluates multiple conditions and returns the first match.' },
    { n: 'NOT', zh: '傳回引數邏輯值的相反值。', en: 'Returns the opposite of a logical value.' },
    { n: 'OR', zh: '若任一引數為 TRUE 則傳回 TRUE。', en: 'Returns TRUE if any argument is TRUE.' },
    { n: 'SWITCH', zh: '比對運算式並傳回第一個相符的結果。', en: 'Tests an expression against cases and returns a match.' },
    { n: 'TRUE', zh: '傳回邏輯值 TRUE。', en: 'Returns the logical value TRUE.' },
    { n: 'XOR', zh: '傳回引數的互斥或 (XOR) 邏輯運算結果。', en: 'Returns the exclusive OR of the arguments.' },

    // --- Text -------------------------------------------------------------
    { n: 'CHAR', zh: '依 Unicode 編碼傳回對應的字元。', en: 'Returns the character for a Unicode number.' },
    { n: 'CLEAN', zh: '移除文字中無法列印的字元。', en: 'Removes non-printable characters from text.' },
    { n: 'CODE', zh: '傳回字串首字元的 Unicode 編碼。', en: 'Returns the Unicode value of the first character.' },
    { n: 'CONCATENATE', zh: '將多個字串合併為單一字串。', en: 'Joins several strings into one string.' },
    { n: 'EXACT', zh: '比較兩字串是否完全相同。', en: 'Tests whether two strings are identical.' },
    { n: 'FIND', zh: '傳回字串在文字中首次出現的位置（區分大小寫）。', en: 'Returns the position of a substring (case-sensitive).' },
    { n: 'LEFT', zh: '傳回字串左側的指定字元數。', en: 'Returns a substring from the start of a string.' },
    { n: 'LEN', zh: '傳回字串的字元數。', en: 'Returns the number of characters in a string.' },
    { n: 'LOWER', zh: '將字串轉換為小寫。', en: 'Converts a string to lowercase.' },
    { n: 'MID', zh: '傳回字串中指定位置起的部分字元。', en: 'Returns a substring from the middle of a string.' },
    { n: 'PROPER', zh: '將每個單字的首字母轉換為大寫。', en: 'Capitalizes the first letter of each word.' },
    { n: 'REGEXEXTRACT', zh: '依正規表示式擷取相符的子字串。', en: 'Extracts matching substrings using a regular expression.' },
    { n: 'REGEXMATCH', zh: '檢查文字是否符合正規表示式。', en: 'Tests whether text matches a regular expression.' },
    { n: 'REGEXREPLACE', zh: '使用正規表示式取代文字。', en: 'Replaces text using a regular expression.' },
    { n: 'REPLACE', zh: '以新字串取代文字中的部分內容。', en: 'Replaces part of a text string with another.' },
    { n: 'REPT', zh: '將文字重複指定的次數。', en: 'Repeats text a given number of times.' },
    { n: 'RIGHT', zh: '傳回字串右側的指定字元數。', en: 'Returns a substring from the end of a string.' },
    { n: 'SEARCH', zh: '傳回字串在文字中首次出現的位置（不分大小寫）。', en: 'Returns the position of a substring (case-insensitive).' },
    { n: 'SPLIT', zh: '依指定分隔符號將文字拆分為多個儲存格。', en: 'Splits text around a specified delimiter.' },
    { n: 'SUBSTITUTE', zh: '以新文字取代字串中的指定文字。', en: 'Substitutes new text for existing text in a string.' },
    { n: 'TEXT', zh: '依指定格式將數字轉換為文字。', en: 'Formats a number as text per a format pattern.' },
    { n: 'TEXTJOIN', zh: '使用分隔符號合併多個字串。', en: 'Joins strings with a delimiter between each.' },
    { n: 'TRIM', zh: '移除文字前後及多餘的空格。', en: 'Removes leading, trailing and repeated spaces.' },
    { n: 'UPPER', zh: '將字串轉換為大寫。', en: 'Converts a string to uppercase.' },
    { n: 'VALUE', zh: '將文字格式的數字轉換為數值。', en: 'Converts a text string of a number to a numeric value.' },

    // --- Date & Time ------------------------------------------------------
    { n: 'DATE', zh: '依年、月、日傳回日期。', en: 'Returns a date from year, month and day.' },
    { n: 'DATEDIF', zh: '計算兩個日期之間相隔的天、月或年。', en: 'Calculates days, months or years between two dates.' },
    { n: 'DATEVALUE', zh: '將日期字串轉換為日期序列值。', en: 'Converts a date string to a serial number.' },
    { n: 'DAY', zh: '傳回日期中的「日」。', en: 'Returns the day of the month for a date.' },
    { n: 'DAYS', zh: '傳回兩個日期之間的天數。', en: 'Returns the number of days between two dates.' },
    { n: 'EDATE', zh: '傳回指定月數前後的日期。', en: 'Returns a date a number of months before/after a date.' },
    { n: 'EOMONTH', zh: '傳回指定月數前後該月的最後一天。', en: 'Returns the last day of the month offset by months.' },
    { n: 'HOUR', zh: '傳回時間中的「時」。', en: 'Returns the hour component of a time.' },
    { n: 'MINUTE', zh: '傳回時間中的「分」。', en: 'Returns the minute component of a time.' },
    { n: 'MONTH', zh: '傳回日期中的「月」。', en: 'Returns the month of the year for a date.' },
    { n: 'NOW', zh: '傳回目前的日期與時間。', en: 'Returns the current date and time.' },
    { n: 'SECOND', zh: '傳回時間中的「秒」。', en: 'Returns the second component of a time.' },
    { n: 'TIME', zh: '依時、分、秒傳回時間。', en: 'Returns a time from hour, minute and second.' },
    { n: 'TODAY', zh: '傳回目前的日期。', en: 'Returns the current date.' },
    { n: 'WEEKDAY', zh: '傳回日期為星期幾（數值）。', en: 'Returns the day of the week as a number.' },
    { n: 'WEEKNUM', zh: '傳回日期落在當年的第幾週。', en: 'Returns the week number of the year for a date.' },
    { n: 'WORKDAY', zh: '傳回指定工作天數前後的日期。', en: 'Returns a date a number of workdays away.' },
    { n: 'YEAR', zh: '傳回日期中的「年」。', en: 'Returns the year for a date.' },
    { n: 'YEARFRAC', zh: '傳回兩日期之間相隔的年數（含小數）。', en: 'Returns the fraction of a year between two dates.' },

    // --- Lookup -----------------------------------------------------------
    { n: 'ADDRESS', zh: '依列號與欄號傳回儲存格參照字串。', en: 'Returns a cell reference as a string from row and column.' },
    { n: 'CHOOSE', zh: '依索引值從清單中傳回對應項目。', en: 'Returns an element from a list by index.' },
    { n: 'COLUMN', zh: '傳回指定儲存格的欄號。', en: 'Returns the column number of a cell.' },
    { n: 'COLUMNS', zh: '傳回指定範圍的欄數。', en: 'Returns the number of columns in a range.' },
    { n: 'HLOOKUP', zh: '在範圍的第一列中橫向搜尋並傳回對應值。', en: 'Searches across the first row and returns a value.' },
    { n: 'INDEX', zh: '依列號與欄號傳回範圍中的儲存格內容。', en: 'Returns the content of a cell by row and column offset.' },
    { n: 'INDIRECT', zh: '依文字字串傳回所指定的儲存格參照。', en: 'Returns a reference specified by a text string.' },
    { n: 'LOOKUP', zh: '在單一列或欄中搜尋並傳回對應值。', en: 'Searches a row or column and returns a value.' },
    { n: 'MATCH', zh: '傳回搜尋項目在範圍中的相對位置。', en: 'Returns the relative position of an item in a range.' },
    { n: 'OFFSET', zh: '依位移量傳回參照的儲存格範圍。', en: 'Returns a range reference shifted by offsets.' },
    { n: 'ROW', zh: '傳回指定儲存格的列號。', en: 'Returns the row number of a cell.' },
    { n: 'ROWS', zh: '傳回指定範圍的列數。', en: 'Returns the number of rows in a range.' },
    { n: 'VLOOKUP', zh: '在範圍的第一欄中縱向搜尋並傳回對應值。', en: 'Searches down the first column and returns a value.' },
    { n: 'XLOOKUP', zh: '搜尋範圍並傳回對應的相符項目。', en: 'Searches a range and returns the corresponding match.' },

    // --- Array ------------------------------------------------------------
    { n: 'ARRAYFORMULA', zh: '對整個陣列範圍套用公式。', en: 'Applies a formula across an array of values.' },
    { n: 'FLATTEN', zh: '將一個或多個範圍合併成單一欄。', en: 'Flattens one or more ranges into a single column.' },
    { n: 'FILTER', zh: '傳回符合指定條件的資料列。', en: 'Returns rows that meet specified conditions.' },
    { n: 'SORT', zh: '依指定欄將範圍列排序。', en: 'Sorts the rows of a range by columns.' },
    { n: 'SORTN', zh: '傳回排序後資料集的前 n 個項目。', en: 'Returns the first n items of a sorted dataset.' },
    { n: 'TRANSPOSE', zh: '轉置陣列或範圍的列與欄。', en: 'Transposes the rows and columns of a range.' },
    { n: 'UNIQUE', zh: '傳回來源範圍中不重複的資料列。', en: 'Returns unique rows from a source range.' },

    // --- Info -------------------------------------------------------------
    { n: 'ISBLANK', zh: '檢查參照的儲存格是否為空白。', en: 'Checks whether a referenced cell is empty.' },
    { n: 'ISERR', zh: '檢查值是否為 #N/A 以外的錯誤。', en: 'Checks whether a value is an error other than #N/A.' },
    { n: 'ISERROR', zh: '檢查值是否為任何錯誤。', en: 'Checks whether a value is any error value.' },
    { n: 'ISLOGICAL', zh: '檢查值是否為布林值 TRUE/FALSE。', en: 'Checks whether a value is TRUE or FALSE.' },
    { n: 'ISNA', zh: '檢查值是否為 #N/A 錯誤。', en: 'Checks whether a value is the #N/A error.' },
    { n: 'ISNUMBER', zh: '檢查值是否為數字。', en: 'Checks whether a value is a number.' },
    { n: 'ISTEXT', zh: '檢查值是否為文字。', en: 'Checks whether a value is text.' },
    { n: 'NA', zh: '傳回 #N/A 錯誤值。', en: 'Returns the #N/A error value.' },

    // --- Financial --------------------------------------------------------
    { n: 'FV', zh: '依固定利率計算投資的未來價值。', en: 'Calculates the future value of an investment.' },
    { n: 'IRR', zh: '計算一系列現金流的內部報酬率。', en: 'Calculates the internal rate of return of cash flows.' },
    { n: 'NPV', zh: '依折現率計算現金流的淨現值。', en: 'Calculates the net present value of cash flows.' },
    { n: 'PMT', zh: '計算貸款的定期付款金額。', en: 'Calculates the periodic payment for a loan.' },
    { n: 'PV', zh: '計算投資的現值。', en: 'Calculates the present value of an investment.' },
    { n: 'RATE', zh: '計算投資每期的利率。', en: 'Calculates the interest rate per period of an investment.' },

    // --- Engineering ------------------------------------------------------
    { n: 'BIN2DEC', zh: '將二進位數字轉換為十進位。', en: 'Converts a signed binary number to decimal.' },
    { n: 'BIN2HEX', zh: '將二進位數字轉換為十六進位。', en: 'Converts a signed binary number to hexadecimal.' },
    { n: 'DEC2BIN', zh: '將十進位數字轉換為二進位。', en: 'Converts a decimal number to signed binary.' },
    { n: 'DEC2HEX', zh: '將十進位數字轉換為十六進位。', en: 'Converts a decimal number to signed hexadecimal.' },
    { n: 'HEX2DEC', zh: '將十六進位數字轉換為十進位。', en: 'Converts a signed hexadecimal number to decimal.' },

    // --- Web --------------------------------------------------------------
    { n: 'HYPERLINK', zh: '建立指向特定網址的連結。', en: 'Creates a hyperlink to a given URL.' },

    // --- Google -----------------------------------------------------------
    { n: 'GOOGLEFINANCE', zh: '從 Google 財經取得證券即時或歷史資料。', en: 'Fetches securities data from Google Finance.' },
    { n: 'GOOGLETRANSLATE', zh: '將文字從一種語言翻譯為另一種語言。', en: 'Translates text from one language into another.' },
    { n: 'IMAGE', zh: '在儲存格中插入指定網址的圖片。', en: 'Inserts an image into a cell from a URL.' }
  ];

  // Expose globally for app.js. Pre-sort by name so the dropdown order is
  // stable and alphabetical within each prefix match.
  FN.sort((a, b) => a.n.localeCompare(b.n));
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.SHEET_FUNCTIONS = FN;
})();
