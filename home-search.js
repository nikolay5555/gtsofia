document.addEventListener("DOMContentLoaded", async () => {

  const input = document.getElementById("homeLineSearch");
  const typeSelect = document.getElementById("homeTransportType");
  const results = document.getElementById("homeLineResults");

  if (!input || !results || !typeSelect) return;

  let homeSearchLines = [];

  // Зареждане на линиите директно от GTFS
  try {
    homeSearchLines = await loadTransportLines();
  } catch (error) {
    console.error("Грешка при зареждане на GTFS линиите:", error);
    return;
  }


  function hideResults() {
    results.innerHTML = "";
    results.style.display = "none";
  }


  function renderResults() {

    const value = input.value.trim().toLowerCase();

    if (!value) {
      hideResults();
      return;
    }


    const selectedType = typeSelect.value;


    const matches = homeSearchLines.filter(line =>
      line.type === selectedType &&
      line.number.toLowerCase().includes(value)
    );


    if (!matches.length) {
      hideResults();
      return;
    }


    results.innerHTML = matches.map(line => {

      let color = line.color;
      let textColor = "white";

      if (line.type === "metro") {
        textColor = line.textColor;
      }


      return `
        <div 
          class="home-search-item"
          data-type="${line.type}"
          data-number="${line.number}"
          style="
            display:flex;
            align-items:center;
            gap:10px;
            padding:10px 14px;
            cursor:pointer;
          "
        >

          ${
            line.type === "metro"
            ?
            `<div style="
              width:30px;
              height:30px;
              border-radius:50%;
              background:${color};
              color:${textColor};
              display:flex;
              align-items:center;
              justify-content:center;
              font-weight:700;
            ">
              ${line.number}
            </div>`
            :
            `<div style="
              width:60px;
              height:30px;
              border-radius:6px;
              background:${color};
              color:white;
              display:flex;
              align-items:center;
              justify-content:center;
              font-weight:700;
            ">
              ${line.number}
            </div>`
          }

          <span>
            ${
              line.type === "bus" ? "Автобус" :
              line.type === "trolleybus" ? "Тролейбус" :
              line.type === "tram" ? "Трамвай" :
              line.type === "metro" ? "Метро" :
              line.type === "night" ? "Нощна линия" :
              ""
            }
          </span>

        </div>
      `;

    }).join("");


    results.style.display = "block";


    document.querySelectorAll(".home-search-item")
      .forEach(item => {

        item.addEventListener("click", () => {

          const type = item.dataset.type;
          const number = item.dataset.number;

          window.location.href =
            `transport.html?line=${type}:${number}`;

        });

      });

  }


  input.addEventListener("input", renderResults);


  typeSelect.addEventListener("change", () => {

    if (input.value.trim()) {
      renderResults();
    }

  });


  // затваряне при клик извън полето
  document.addEventListener("click", (e) => {

    if (!input.contains(e.target) &&
        !results.contains(e.target) &&
        !typeSelect.contains(e.target)) {

      hideResults();

    }

  });


});
