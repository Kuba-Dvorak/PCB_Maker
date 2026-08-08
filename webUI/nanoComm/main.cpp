#include <iostream>
#include <algorithm>
#include <array>
#include <cerrno>
#include <ctime>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <nlohmann/json.hpp>
#include <cmath>
#include <thread>
#include <chrono>

#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <unistd.h>

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json = nlohmann::json;


// Vsechno, co jde na konzoli, se zaroven zapisuje do souboru v logs/. Bez
// toho se po zavreni terminalu ztrati cely prubeh jobu, coz je pri hledani
// chyby na stroji presne to, co clovek potrebuje nejvic.
//
// Je to streambuf a ne obalka nad kazdym std::cout, aby se nemuselo sahat
// na zadny z existujicich vypisu - staci vymenit buffer v main().
//
// Do souboru se pred kazdy radek pise cas. Na konzoli ne, tam by jen prekazel,
// ale ve zpetne analyze je casovani to nejcennejsi (jak dlouho trval zajezd,
// za jak dlouho prisel report).
class logTee : public std::streambuf {
public:
    logTee(std::streambuf *consoleBuf, fs::path directory, std::string prefix, long maxLines = 15000)
        : console(consoleBuf), dir(std::move(directory)), namePrefix(std::move(prefix)), lineLimit(maxLines) {
        std::error_code err;
        fs::create_directories(dir, err);
        openNewFile();
    }

    ~logTee() override {
        if (file.is_open()) {
            file.flush();
            file.close();
        }
    }

    fs::path currentPath() const {
        return activePath;
    }

protected:
    int overflow(int c) override {
        if (c == EOF) {
            return !EOF;
        }

        if (console != nullptr) {
            console->sputc(static_cast<char>(c));
        }

        if (!file.is_open()) {
            return c;
        }

        if (atLineStart) {
            file << nowText("[%H:%M:%S] ");
            atLineStart = false;
        }

        file.put(static_cast<char>(c));

        if (c == '\n') {
            atLineStart = true;
            writtenLines += 1;
            // Flush po kazdem radku schvalne: kdyz proces spadne nebo ho
            // nekdo zabije, nesmi se ztratit prave ten posledni radek.
            file.flush();

            if (writtenLines >= lineLimit) {
                openNewFile();
            }
        }

        return c;
    }

    int sync() override {
        if (console != nullptr) {
            console->pubsync();
        }

        if (file.is_open()) {
            file.flush();
        }

        return 0;
    }

private:
    static std::string nowText(const char *format) {
        std::time_t raw = std::time(nullptr);
        std::tm parts = {};
        localtime_r(&raw, &parts);
        char text[64] = {};
        std::strftime(text, sizeof(text), format, &parts);
        return std::string(text);
    }

    void openNewFile() {
        if (file.is_open()) {
            file << "--- limit " << lineLimit << " lines reached, continuing in a new file ---\n";
            file.close();
        }

        std::string stamp = nowText("%Y-%m-%d_%H-%M-%S");
        fs::path candidate = dir / (namePrefix + "-" + stamp + ".txt");

        // Dve rotace ve stejne sekunde jsou nepravdepodobne, ale prepsat
        // predchozi log by bylo horsi nez oskliva pripona.
        for (int attempt = 2; fs::exists(candidate) && attempt < 1000; attempt += 1) {
            candidate = dir / (namePrefix + "-" + stamp + "-" + std::to_string(attempt) + ".txt");
        }

        activePath = candidate;
        file.open(activePath, std::ios::out | std::ios::app);
        writtenLines = 0;
        atLineStart = true;
    }

    std::streambuf *console;
    std::ofstream file;
    fs::path dir, activePath;
    std::string namePrefix;
    long writtenLines = 0;
    long lineLimit;
    bool atLineStart = true;
};


// Slozka s logy. CNC_LOG_DIR ma prednost, jinak se odvodi od umisteni binarky
// (build/nanoComm -> ../../logs = webUI/logs), aby to nezaviselo na tom,
// odkud se demon spustil - pod systemd je cwd typicky "/".
fs::path resolveLogDir() {
    const char *fromEnv = std::getenv("CNC_LOG_DIR");

    if (fromEnv != nullptr && fromEnv[0] != '\0') {
        return fs::path(fromEnv);
    }

    std::error_code err;
    fs::path self = fs::read_symlink("/proc/self/exe", err);

    if (err) {
        return fs::path("logs");
    }

    return fs::weakly_canonical(self.parent_path() / ".." / ".." / "logs", err);
}


struct Position {
    float x, y;
};


void markString(std::string &curString) {
    curString += '\n';
    curString.insert(0, "$");
}


//cmd 1 = jednoduchy move, cmd 0 = ping a otestovani, cmd 2 = nastaveni rychlosti spindl, cmd 3 = homing
struct basicCMD {
    uint8_t command;
    Position position;
    float z, speed, spindleSpeed;

    basicCMD(uint8_t cmd = 12, Position position = {-1, -1}, float z = -1, float speed = -1, float spindleSpeed = -1) {
        this->command = cmd;
        this->position = position;
        this->z = z;
        this->speed = speed;
        this->spindleSpeed = spindleSpeed;
    }

    void prepareForNano(char buffer[], size_t bufSize) {
        std::string prepareString;
        prepareString += std::to_string(command);
        prepareString += ';';
        prepareString += std::to_string(position.x);
        prepareString += ';';
        prepareString += std::to_string(position.y);
        prepareString += ';';
        prepareString += std::to_string(z);
        prepareString += ';';
        //standart for having pcb2gcode in mm/min -> mm/s
        prepareString += std::to_string(speed);
        prepareString += ';';
        prepareString += std::to_string(spindleSpeed);
        prepareString += ';';
        markString(prepareString);
        if (prepareString.length() >= bufSize) {
            std::cout << "[UART] Prepared command is too long for UART buffer and will be truncated. Length: "
                      << prepareString.length() << ", buffer size: " << bufSize << "." << std::endl;
        }
        std::strncpy(buffer, prepareString.c_str(), bufSize - 1);
        buffer[bufSize - 1] = '\0';
    }
};

// error 0 = ok, error 1 = neco ....
// status 0 = zprava od nana, status 1 = zprava od nanoComm
struct nanoReport {
    uint8_t status;
    uint8_t error;
    Position position;
    float z;
    float speed, spindlSpeed;
    uint8_t endstops;

    // Postup v G-kodu. Nano o radcich nic nevi, tyhle dve pole plni az
    // nanoComm v doGcodeTask. -1 znamena "zadny job nebezi" - podle toho
    // frontend pozna, jestli ma zamknout jogovani.
    int gcodeLine = -1;
    int gcodeLines = -1;

    nanoReport(uint8_t status = 0, uint8_t error = 0, Position position = {0, 0}, float z = 0, float speed = 0, float spindlSpeed = 0, uint8_t endstops = 0) {
        this->status = status;
        this->error = error;
        this->position = position;
        this->z = z;
        this->speed = speed;
        this->spindlSpeed = spindlSpeed;
        this->endstops = endstops;
    }
};


NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(Position, x, y);

NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(nanoReport, status, error, position, z, speed, spindlSpeed, endstops, gcodeLine, gcodeLines);


float loadNumberForData(int &currentChar, std::string &text) {
    float oneNumber = 0;
    float floatinDecimal = 0;
    bool negativity = false;
    bool fullNum = false;
    char curChar = ' ';

    while (currentChar < text.length()) {
        curChar = text[currentChar];
        if (std::isdigit(curChar)) {
            break;
        }

        if (curChar == '-') {
            negativity = true;
        }

        currentChar += 1;
    }

    while (currentChar < text.length()) {
        curChar = text[currentChar];
        if (!(std::isdigit(curChar)) && !(curChar == '.')) {
            break;
        }

        if (curChar == '.' && !fullNum) {
            fullNum = true;
            currentChar += 1;
            continue;
        }

        if (fullNum) {
            floatinDecimal += 1;
        }

        oneNumber *= 10;
        oneNumber += int(curChar - '0');
        currentChar += 1;

        if (currentChar >= text.length()) {
            break;
        }
    }

    oneNumber /= std::pow(10, floatinDecimal);
    if (negativity) {
        oneNumber *= -1;
    }

    return oneNumber;
}


bool reportHasDelimiter(const std::string &curString, int curChar, const char *fieldName) {
    if (curChar >= static_cast<int>(curString.length())) {
        std::cout << "[UART] Malformed Nano report: missing delimiter after " << fieldName << "." << std::endl;
        return false;
    }

    if (curString[curChar] != ';') {
        std::cout << "[UART] Malformed Nano report: expected ';' after " << fieldName
                  << ", got '" << curString[curChar] << "'." << std::endl;
        return false;
    }

    return true;
}


void datafieng(std::string &curString, nanoReport &changeReport) {
    if (curString.empty()) {
        std::cout << "[UART] Malformed Nano report: empty payload." << std::endl;
        return;
    }

    int curChar = 0;
    changeReport.status = int(loadNumberForData(curChar, curString));
    if (reportHasDelimiter(curString, curChar, "status")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.error = int(loadNumberForData(curChar, curString));
    if (reportHasDelimiter(curString, curChar, "error")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.position.x = loadNumberForData(curChar, curString) / 100;
    if (reportHasDelimiter(curString, curChar, "x")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.position.y = loadNumberForData(curChar, curString) / 100;
    if (reportHasDelimiter(curString, curChar, "y")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.z = loadNumberForData(curChar, curString) / 100;
    if (reportHasDelimiter(curString, curChar, "z")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.speed = loadNumberForData(curChar, curString) / 100;
    if (reportHasDelimiter(curString, curChar, "speed")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.spindlSpeed = loadNumberForData(curChar, curString) / 100;
    if (reportHasDelimiter(curString, curChar, "spindleSpeed")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.endstops = int(loadNumberForData(curChar, curString));
    return;
}


struct uartComm {
    std::string port;
    bool occupied;
    int baundWith;
    int serialID;

    uartComm(std::string port = "/dev/ttyUSB0", int baundWith = 9600) {
        this->port = port;
        occupied = false;
        this->baundWith = baundWith;
        serialID = -1;
    }

    void startComm() {
        serialID = open(port.c_str(), O_RDWR | O_NOCTTY);

        if (serialID < 0) {
            std::cout << "[UART] Unable to connect to port " << port << ": " << std::strerror(errno) << "." << std::endl;
            return;
        }

        termios tty;

        if (tcgetattr(serialID, &tty) != 0) {
            std::cout << "[UART] Unable to get port configuration for " << port << ": " << std::strerror(errno) << "." << std::endl;
            return;
        }

        speed_t speed;

        if (baundWith == 115200) {
            speed = B115200;
        } else if (baundWith == 9600) {
            speed = B9600;
        } else {
            std::cout << "[UART] Unsupported baud rate " << baundWith << ", falling back to 9600." << std::endl;
            speed = B9600;
        }

        cfsetospeed(&tty, speed);
        cfsetispeed(&tty, speed);

        tty.c_cflag &= ~PARENB;
        tty.c_cflag &= ~CSTOPB;
        tty.c_cflag &= ~CSIZE;
        tty.c_cflag |= CS8;

        tty.c_cflag &= ~CRTSCTS;

        tty.c_cflag |= CREAD | CLOCAL;

        tty.c_lflag &= ~ICANON;
        tty.c_lflag &= ~ECHO;
        tty.c_lflag &= ~ISIG;
        tty.c_oflag &= ~OPOST;

        tty.c_cc[VMIN]  = 0;
        tty.c_cc[VTIME] = 1;

        if (tcsetattr(serialID, TCSANOW, &tty) != 0) {
            std::cerr << "[UART] Unable to save port configuration for " << port << ": " << std::strerror(errno) << "." << std::endl;
            return;
        }

        std::cout << "[UART] Port " << port << " successfully opened at " << baundWith << " baud." << std::endl;
    }

    // Prelozi cislo prikazu na jmeno podle commProtocol.txt, aby se z konzole
    // dalo poznat, co se posila, bez listovani v tabulce.
    const char* nameOfCMD(uint8_t command) {
        switch (command) {
            case 0:   return "ping";
            case 1:   return "absolute move XY";
            case 2:   return "set spindle speed";
            case 3:   return "home to MIN";
            case 4:   return "home to MAX";
            case 5:   return "lift Z then move";
            case 6:   return "spindle off";
            case 7:   return "end of job";
            case 8:   return "relative move";
            case 12:  return "no instruction, Nano sends no report";
            case 255: return "end of job";
            default:  return "unknown command";
        }
    }

    // -1 znamena "tohle pole ignoruj". Nesmi to byt pomlcka ani nic, co jde
    // splest s minusem - na drat jde porad -1.000000, tohle je jen popisek.
    std::string fieldOfCMD(float value) {
        if (value == -1) {
            return "unset";
        }

        std::ostringstream out;
        out << std::fixed;
        out.precision(2);
        out << value;
        return out.str();
    }

    void sendBasicCMD(basicCMD cmd) {
        (void)cmd;
        occupied = true;

        if (serialID == -1) {
            std::cout << "[UART] Cannot send cmd " << int(cmd.command) << " (" << nameOfCMD(cmd.command)
                      << "): serial port is not open." << std::endl;
            occupied = false;
            return;
        }

        char buffer[64] = {};
        cmd.prepareForNano(buffer, sizeof(buffer));

        // Ramec konci '\n', ktery by v logu udelal prazdny radek navic.
        std::string frame(buffer);
        if (!frame.empty() && frame.back() == '\n') {
            frame.pop_back();
        }

        // Log jde pred write zamerne: kdyz zapis selze, prectou se ty dva radky
        // za sebou jako "tohle jsem posilal" a "a takhle to dopadlo".
        std::cout << "[UART] -> Nano: cmd " << int(cmd.command) << " (" << nameOfCMD(cmd.command) << ")"
                  << " X=" << fieldOfCMD(cmd.position.x)
                  << " Y=" << fieldOfCMD(cmd.position.y)
                  << " Z=" << fieldOfCMD(cmd.z)
                  << " speed=" << fieldOfCMD(cmd.speed)
                  << " spindle=" << fieldOfCMD(cmd.spindleSpeed)
                  << " | frame " << frame << std::endl;

        ssize_t result = write(serialID, buffer, strlen(buffer));

        if (result < 0) {
            std::cout << "[UART] Failed to write command to " << port << ": " << std::strerror(errno) << "." << std::endl;
        }

        else if (result < static_cast<ssize_t>(strlen(buffer))) {
            std::cout << "[UART] Partial command write to " << port << ": wrote " << result
                      << " of " << strlen(buffer) << " bytes." << std::endl;
        }
        occupied = false;
    }

    // Report z Nana nese jen cislo. Tohle ho prelozi do vety, aby se z konzole
    // dalo poznat, co se stalo, bez listovani v commProtocol.txt. Error 0 se
    // schvalne nelogruje - to by pri jobu psalo radek ke kazdemu prikazu.
    void consoleLogFromError(int error, uint8_t endstops = 0) {
        switch (error) {
            case 0:
                break;
            case 3:
                std::cout << "[NANO] Nano could not parse the command it received, the frame was damaged over UART." << std::endl;
                break;
            case 4:
                std::cout << "[NANO] Ping answered, Nano is alive." << std::endl;
                break;
            case 5:
                std::cout << "[NANO] Nano does not know this command number." << std::endl;
                break;
            case 6:
                std::cout << "[NANO] Target was outside the work area and got clamped to the nearest edge, the machine moved somewhere else than requested." << std::endl;
                break;
            // Error 7 ma dve uplne ruzne priciny a driv se obe hlasily stejnou
            // vetou, coz se nedalo rozlisit. Maska koncaku je rozhodne: kdyz
            // je nenulova, endstop se sepnul PRAVE ted. Kdyz je nula, jde
            // o myCalib.homed = false, ktery je LEPKAVY - interuptZ ho shodi
            // pri prvnim doteku koncaku a zpatky ho zvedne uz jen home().
            // Do te doby hlasi error 7 uplne kazdy dalsi pohyb.
            case 7:
                if (endstops != 0) {
                    std::cout << "[NANO] An endstop was hit during this move. The reported position is no longer trustworthy." << std::endl;
                }

                else {
                    std::cout << "[NANO] Machine is not homed, so every move reports error 7 until homing runs again."
                              << " No endstop was hit by this particular command." << std::endl;
                }
                break;
            case 8:
                std::cout << "[NANO] End of job, spindle is off and all axes are homed to maximum." << std::endl;
                break;
            case 10:
                std::cout << "[NANO] EMERGENCY button pressed. Motors and spindle are off and the step timer is stopped." << std::endl;
                break;
            default:
                std::cout << "[NANO] Unknown error code " << error << ", see commProtocol.txt." << std::endl;
                break;
        }
    }

    // Maska koncaku je latchovana za cely posledni prikaz, takze staci vypsat
    // ji jednou po prijeti reportu. Nula je bezny stav a ta se nelogruje.
    void consoleLogFromEndstops(uint8_t endstops) {
        if (endstops == 0) {
            return;
        }

        std::cout << "[NANO] Endstops hit during the last command (mask " << int(endstops) << "):";
        if (endstops & 1)  { std::cout << " Xmin"; }
        if (endstops & 2)  { std::cout << " Xmax"; }
        if (endstops & 4)  { std::cout << " Ymin"; }
        if (endstops & 8)  { std::cout << " Ymax"; }
        if (endstops & 16) { std::cout << " Zmin"; }
        if (endstops & 32) { std::cout << " Zmax"; }
        std::cout << "." << std::endl;
    }

    nanoReport listenUART() {
        if (!occupied) {
            occupied = true;
            nanoReport data = nanoReport(1, 0);

            if (serialID == -1) {
                std::cout << "[UART] Cannot listen: serial port is not open." << std::endl;
                occupied = false;
                return nanoReport(1, 7);
            }

            std::string readBuffer = "";
            char buffer[64] = {};
            ssize_t result;
            bool started = false;
            bool complete = false;

            // VTIME = 1 znamena, ze read() se vraci prazdny kazdych 100 ms.
            // Logovat kazdy takovy pokus by pri cekani na dlouhy pohyb zaplavilo
            // konzoli tisicema radku a zahltilo UART hlaskou o tom, ze se ceka.
            // Proto se hlasi az kazdy padesaty pokus, tedy zhruba po peti
            // sekundach ticha - to uz je doba, kdy stoji za to vedet, ze se ceka.
            const long logEveryNthPoll = 50;
            long emptyReads = 0;
            long ignoredChunks = 0;

            std::chrono::seconds timeOut = std::chrono::seconds(600);
            std::chrono::time_point deadLine = std::chrono::steady_clock::now() + timeOut;

            while (std::chrono::steady_clock::now() <= deadLine) {
                result = read(serialID, buffer, 64);

                if (result == 0) {
                    emptyReads += 1;
                    if (emptyReads % logEveryNthPoll == 0) {
                        std::cout << "[UART] Still waiting for a report from Nano on " << port
                                  << ", roughly " << (emptyReads / 10) << " s of silence so far." << std::endl;
                    }
                    continue;
                }

                if (result < 0) {
                    close(serialID);
                    serialID = -1;
                    occupied = false;
                    std::cout << "[UART] Arduino disconnected while reading command on port " << port << "." << std::endl;
                    return nanoReport(1, 6);
                }

                std::string currentData = std::string(buffer, result);

                if (!started) {
                    size_t startChar = currentData.find('$');

                    if (startChar == std::string::npos) {
                        ignoredChunks += 1;
                        // Prvni zahozeny kus se hlasi hned, protoze uz jeden
                        // znamena rozsypany ramec. Dal se to throttluje, aby
                        // trvale zaneseny port neprevalcoval zbytek logu.
                        if (ignoredChunks == 1 || ignoredChunks % logEveryNthPoll == 0) {
                            std::cout << "[UART] Ignoring " << result << " B without a $ start marker on port " << port
                                      << ", " << ignoredChunks << " chunk(s) dropped so far." << std::endl;
                        }
                        continue;
                    }

                    else {
                        started = true;
                        currentData.erase(0, startChar + 1);
                    }
                }


                if (started) {
                    size_t endChar = currentData.find('\n');

                    if (endChar == std::string::npos) {
                        readBuffer.append(currentData);
                        continue;
                    }

                    else {
                        currentData.erase(endChar, 64);
                        readBuffer.append(currentData);
                        complete = true;
                        break;
                    }
                }

            }

            occupied = false;

            // POZOR: kdyz vyprsi deadline, cyklus skonci uplne stejne jako po
            // uspesnem prijeti a datafieng dole rozparsuje to, co zbylo v
            // bufferu. Report pak odejde jako status 1 / error 0, tedy "vse
            // v poradku", i kdyz Nano deset minut neposlalo nic. Nez se to
            // opravi navratovou hodnotou, aspon at je to videt v konzoli.
            if (!complete) {
                std::cout << "[UART] Timed out after " << timeOut.count() << " s without a complete report from " << port
                          << ". Start marker " << (started ? "was seen" : "never arrived")
                          << ", " << readBuffer.length() << " B buffered. Nano is most likely stuck or reset."
                          << std::endl;
            }

            std::cout << "[UART] Received Nano report payload: " << readBuffer << std::endl;
            datafieng(readBuffer, data);
            consoleLogFromError(data.error, data.endstops);
            consoleLogFromEndstops(data.endstops);
            return data;
        }
        std::cout << "[UART] Cannot listen: UART is already occupied." << std::endl;
        return nanoReport(1, 2);
    }
};


struct gcodeDecoder {
    std::string gcodeText;
    size_t currentChar;
    std::array<char, 2> commandChars = {'G', 'M'};
    std::array<char, 7> instructionChars = {'X', 'Y', 'Z', 'I', 'J', 'F', 'S'};

    // --- naklon stolu -----------------------------------------------------
    // Deska stolu neni vodorovna, smerem k max X klesa. Korekce je linearni
    // v X a je to vlastnost STROJE, ne desky - proto se pocita ze souradnic
    // stroje a ne z rozsahu, ktery ma zrovna nacteny soubor. Kdyby se brala
    // z desky, dostala by mala deska uprostred stolu cely spad na par mm.
    //
    // Zmerene hodnoty: v hloubce rezu musi hrot stat na Z 1.20 na X 3
    // a na Z 1.05 na X 57. Plati pro souradny system, kde Z = 0 je doraz
    // Zmin, tedy 1.2 mm pod povrchem medi.
    // Vypinac pro A/B test. false = zadna korekce, do kazdeho rezneho pohybu
    // se dosadi rovnou gcodeCutZ, takze se Z za celou dratu nehne a chova se
    // to jako pred zavedenim levelingu. Slouzi k rozliseni, jestli pripadny
    // problem dela naklon, nebo neco jineho.
    bool tiltEnabled = true;

    float tiltXMin = 3.0f, tiltXMax = 57.0f;
    float tiltZAtXMin = 1.20f, tiltZAtXMax = 1.05f;

    // Hloubka rezu, kterou pise pcb2gcode (zwork v printer/millproject).
    // Slouzi jen jako znacka "tenhle Z je rezny", skutecnou hodnotu urcuji
    // tiltZAtXMin/Max vyse. Kdyz se zmeni millproject, musi se zmenit i tady.
    float gcodeCutZ = 1.1f;

    // Kroku na 1 mm osy Z, musi sedet se stepLenghtT8 v nanoCode/src/main.cpp.
    float zStepsPerMM = 200.0f;

    // Stav, ktery samotny radek G-kodu nenese. pcb2gcode pise Z jen kdyz se
    // meni, takze "G01 X.. Y.." samo o sobe nerekne, jestli se rezze nebo
    // prejizdi nad deskou. A M3 posila bez S.
    float lastX = -1;
    float lastSpindleSpeed = -1;
    bool cutting = false;

    gcodeDecoder(std::string gcodeText = "", size_t currentChar = 0) {
        this->gcodeText = gcodeText;
        this->currentChar = currentChar;
    }

    bool contains() {
        if (gcodeText[currentChar] == instructionChars[0] ||  gcodeText[currentChar] == instructionChars[1] || gcodeText[currentChar] == instructionChars[2] ||
            gcodeText[currentChar] == instructionChars[3] || gcodeText[currentChar] == instructionChars[4] || gcodeText[currentChar] == instructionChars[5] || gcodeText[currentChar] == instructionChars[6]) {
            return true;
        }
        return false;
    }


    float loadNumber() {
        float oneNumber = 0;
        float floatinDecimal = 0;
        bool negativity = false;
        bool fullNum = false;
        char curChar = ' ';

        while (currentChar < gcodeText.length()) {
            curChar = gcodeText[currentChar];
            if (std::isdigit(curChar)) {
                break;
            }

            if (curChar == '-') {
                negativity = true;
            }

            if (curChar == '\n' || curChar == '\r') {
                return -1;
            }

            currentChar += 1;
        }

        while (currentChar < gcodeText.length()) {
            curChar = gcodeText[currentChar];
            if (!(std::isdigit(curChar)) && !(curChar == '.')) {
                break;
            }

            if (curChar == '.' && !fullNum) {
                fullNum = true;
                currentChar += 1;
                continue;
            }

            if (fullNum) {
                floatinDecimal += 1;
            }

            oneNumber *= 10;
            oneNumber += int(curChar - '0');
            currentChar += 1;

            if (currentChar >= gcodeText.length()) {
                break;
            }
        }

        oneNumber /= std::pow(10, floatinDecimal);
        if (negativity) {
            oneNumber *= -1;
        }

        return oneNumber;
    }


    int determineCMD(char curChar, int curNum) {
        if (curChar == 'G') {
            if (curNum == 0) {
                return 5;
            }
            if (curNum == 1) {
                return 1;
            }

            else if (curNum == 20) {
                std::cout << "[GCODE] G20 inch units are not implemented yet." << std::endl;
            }

            else if (curNum == 21) {
                std::cout << "[GCODE] G21 millimeter units are not implemented yet." << std::endl;
            }

            else if (curNum == 90) {
                std::cout << "[GCODE] G90 absolute positioning is not implemented yet." << std::endl;
            }

            else if (curNum == 91) {
                std::cout << "[GCODE] G91 relative positioning is not implemented yet." << std::endl;
            }
        }

        else if (curChar == 'M') {
            if (curNum == 3) {
                return 2;
            }
            else if (curNum == 5) {
                return 6;
            }
            // pcb2gcode zavira soubor prikazem M2, jine generatory posilaji
            // M30. Obe znamenaji konec programu, tak se bere oboji.
            else if (curNum == 2 || curNum == 30) {
                return 7;
            }
        }
        std::cout << "[GCODE] Unsupported command: " << curChar << curNum << std::endl;
        return 254;
    }


    void createCMD(basicCMD &cmd, float number, char curChar) {
        if (curChar == instructionChars[0]) {
            cmd.position.x = number;
        }
        else if (curChar == instructionChars[1]) {
            cmd.position.y = number;
        }
        else if (curChar == instructionChars[2]) {
            cmd.z = number;
        }
        else if (curChar == instructionChars[5]) {
            cmd.speed = number / 60;
        }
        else if (curChar == instructionChars[6]) {
            cmd.spindleSpeed = number;
        }
    }


    // Hloubka rezu pro dane X po zapocteni naklonu stolu, zaokrouhlena na
    // cely krok osy Z. To zaokrouhleni neni kosmetika: sklon je 0.0028 mm
    // na 1 mm X, takze na beznem segmentu (median 0.23 mm) vyjde zmena Z
    // na desetinu kroku. Kdyby se posilaly nezaokrouhlene hodnoty, firmware
    // by kazdou z nich orizl na nula kroku a naklon by se nikdy neprojevil.
    // Takhle se Z drzi na mrizce a posune se o presne jeden krok vzdycky,
    // kdyz uz na nej X ujelo dost.
    float cutZForX(float x) const {
        if (!tiltEnabled) {
            return gcodeCutZ;
        }

        if (x < tiltXMin) {
            x = tiltXMin;
        }

        if (x > tiltXMax) {
            x = tiltXMax;
        }

        float ratio = (x - tiltXMin) / (tiltXMax - tiltXMin);
        float wanted = tiltZAtXMin + (tiltZAtXMax - tiltZAtXMin) * ratio;

        return std::round(wanted * zStepsPerMM) / zStepsPerMM;
    }


    // Doplni do instrukce to, co v ni pcb2gcode nenapsal, ale firmware to
    // potrebuje: otacky vretena a Z opravene o naklon stolu. Obojí zavisi
    // na predchozich radcich, proto to nemuze byt v createCMD().
    void applyMachineState(basicCMD &cmd) {
        // pcb2gcode posila "M3" bez S. Bez zapamatovani posledniho S by
        // controlSpindl() dostal -1, hned by se vratil a vreteno by po
        // uvodnim M5 zustalo stat cely job.
        if (cmd.spindleSpeed > -0.5f) {
            lastSpindleSpeed = cmd.spindleSpeed;
        }

        else if (cmd.command == 2) {
            cmd.spindleSpeed = lastSpindleSpeed;
        }

        if (cmd.position.x > -0.5f) {
            lastX = cmd.position.x;
        }

        // Explicitni Z je jediny okamzik, kdy se da poznat, jestli se od ted
        // rezze nebo prejizdi. Vyjezdy na zsafe/zchange tim rez ukonci.
        if (cmd.z > -0.5f) {
            cutting = std::fabs(cmd.z - gcodeCutZ) < 0.001f;
        }

        // Z ma smysl dosazovat jen do pohybu. M-prikazy ho ignoruji, ale at
        // se v logu neobjevuje Z u prikazu, ktery s nim nema co delat.
        if (cmd.command != 1 && cmd.command != 5) {
            return;
        }

        if (!cutting || lastX < 0) {
            return;
        }

        cmd.z = cutZForX(lastX);
    }


    // Cislo radku, na kterem dekoder stoji, a kolik jich soubor ma. Pocita se
    // az na vyzadani - drzet to prubezne by znamenalo hlidat kazdy inkrement
    // currentChar na peti mistech. Soubor ma radove desitky kB a prochazi se
    // jednou za prikaz, takze to nic nestoji.
    int currentLine() const {
        if (gcodeText.empty()) {
            return 0;
        }

        size_t upTo = std::min(currentChar, gcodeText.length());
        return (int)std::count(gcodeText.begin(), gcodeText.begin() + upTo, '\n') + 1;
    }


    int totalLines() const {
        if (gcodeText.empty()) {
            return 0;
        }

        return (int)std::count(gcodeText.begin(), gcodeText.end(), '\n') + 1;
    }


    basicCMD nextInstr() {
        bool firstCmd = true;
        basicCMD generatedCMD = basicCMD();
        while (true) {
            if (gcodeText.length() <= currentChar) {
                generatedCMD.command = 255;
                std::cout << "[GCODE] End of G-code reached." << std::endl;
                break;
            }

            // pcb2gcode pise komentare do kulatych zavorek a ty jsou plne
            // pismen, ktera tenhle dekoder jinak cte jako prikazy a parametry:
            //   "( Millimeters per minute feed rate. )" -> M bez cisla
            //   "( RPM spindle speed. )"                -> M bez cisla
            //   "( Mill infeed pass 1/1 )"              -> dokonce M1
            //   "( Feedrate. )"                         -> F bez cisla
            // To posledni je nejhorsi: loadNumber() vrati -1, createCMD z toho
            // udela speed = -1/60 = -0.0167 mm/s a prepise tim spravnych
            // 3.33 mm/s, ktere na tom radku opravdu byly. Cely blok vcetne
            // zavorek se proto musi preskocit.
            if (gcodeText[currentChar] == '(') {
                size_t commentEnd = gcodeText.find(')', currentChar);
                currentChar = (commentEnd == std::string::npos) ? gcodeText.length() : commentEnd + 1;
                continue;
            }

            if (gcodeText[currentChar] == commandChars[0] || gcodeText[currentChar] == commandChars[1]) {
                if (firstCmd) {
                    firstCmd = false;
                    char curChar = gcodeText[currentChar];
                    generatedCMD.command = determineCMD(curChar, int(loadNumber()));
                    continue;
                }
                break;
            }

            if (contains()) {
                char curChar = gcodeText[currentChar];
                createCMD(generatedCMD, loadNumber(), curChar);
            }

            currentChar += 1;
        }

        applyMachineState(generatedCMD);
        return generatedCMD;
    }
};


struct tcpCommUser {
    int port, serverID, socketID;
    std::string readBuffer;
    char startCharr, endCharr, stopCharr, pauseCharr, continueCharr;

    tcpCommUser(int port = 5000) {
        this->port = port;
        serverID = -1;
        socketID = -1;
        startCharr = '$';
        endCharr = '\n';
        stopCharr = '#';
        pauseCharr = ';';
        continueCharr = '|';
    }

    void startServer() {
        sockaddr_in address = sockaddr_in();
        int opt = 1;

        serverID = socket(AF_INET, SOCK_STREAM, 0);
        if (serverID < 0) {
            std::cerr << "[TCP] Failed to create server socket on port " << port << ": " << std::strerror(errno) << std::endl;
            exit(EXIT_FAILURE);
        }

        if (setsockopt(serverID, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
            std::cerr << "[TCP] Failed to configure SO_REUSEADDR on port " << port << ": " << std::strerror(errno) << std::endl;
            exit(EXIT_FAILURE);
        }

        address.sin_family = AF_INET;
        address.sin_addr.s_addr = INADDR_ANY;
        address.sin_port = htons(port);

        if (bind(serverID, (sockaddr*)&address, sizeof(address)) < 0) {
            std::cerr << "[TCP] Failed to bind server socket on port " << port << ": " << std::strerror(errno) << std::endl;
            exit(EXIT_FAILURE);
        }

        if (listen(serverID, 3) < 0) {
            std::cerr << "[TCP] Failed to listen on port " << port << ": " << std::strerror(errno) << std::endl;
            exit(EXIT_FAILURE);
        }
    }


    void waitForBackend() {
        sockaddr_in address = sockaddr_in();
        int addrSize = sizeof(address);
        std::cout << "[TCP] Waiting for backend connection on port " << port << "..." << std::endl;

        socketID = accept(serverID, (sockaddr*)&address, (socklen_t*)&addrSize);

        if (socketID < 0) {
            std::cout << "[TCP] Backend connection failed on port " << port << ": " << std::strerror(errno) << std::endl;
        }
        else {
            std::cout << "[TCP] Backend connected on port " << port << "." << std::endl;
        }
    }


    void sendData(nanoReport report) {
        if (socketID < 0) {
            std::cout << "[TCP] Cannot send report: backend is not connected on port " << port << "." << std::endl;
            return;
        }
        json rawJson = report;
        std::string rawText = rawJson.dump();
        rawText.insert(0, "$");
        rawText += '\n';

        size_t sentBytes = 0;
        while (sentBytes < rawText.length()) {
            ssize_t result = send(socketID, rawText.data() + sentBytes, rawText.length() - sentBytes, 0);

            if (result < 0 && errno == EINTR) {
                std::cout << "[TCP] Send interrupted by signal, retrying on port " << port << "." << std::endl;
                continue;
            }

            if (result <= 0) {
                close(socketID);
                socketID = -1;
                std::cout << "[TCP] Backend disconnected while sending report on port " << port << "." << std::endl;
                return;
            }

            sentBytes += result;
        }
    }


    json readData() {
        // Driv se tady jen vypsala hlaska a slo se dal, takze po odpojeni
        // backendu se smycka tocila dokola: 20x za sekundu dva radky do logu
        // a zadna sance na obnoveni spojeni. Na Pi to znamenalo ~10 MB do
        // journalu za hodinu a nutnost restartovat i nanoComm pokazde, kdyz
        // se restartoval backend. accept() blokuje, takze se ceka potichu
        // a spojeni se obnovi samo.
        if (socketID < 0) {
            std::cout << "[TCP] Backend is gone on port " << port << ", waiting for it to connect again." << std::endl;
            waitForBackend();
            return nullptr;
        }

        readBuffer = "";
        char buffer[1024] = {};
        ssize_t result;
        bool started = false;

        while (true) {
            result = read(socketID, buffer, 1024);

            if (result <= 0) {
                close(socketID);
                socketID = -1;
                std::cout << "[TCP] Backend disconnected while reading command on port " << port << "." << std::endl;
                return nullptr;
            }

            std::string currentData = std::string(buffer, result);

            if (!started) {
                size_t startChar = currentData.find(startCharr);

                if (startChar == std::string::npos) {
                    std::cout << "[TCP] Ignoring data without start marker on port " << port << "." << std::endl;
                    continue;
                }

                else {
                    started = true;
                    currentData.erase(0, startChar + 1);
                }
            }


            if (started) {
                size_t endChar = currentData.find(endCharr);

                if (endChar == std::string::npos) {
                    readBuffer.append(currentData);
                    continue;
                }

                else {
                    currentData.erase(endChar, 1024);
                    readBuffer.append(currentData);
                    break;
                }
            }

        }

        try {
            json returnJson = json::parse(readBuffer);
            return returnJson;
        } catch (const json::parse_error& error) {
            std::cout << "[TCP] Invalid JSON command on port " << port << ": " << error.what() << std::endl;
            return nullptr;
        }
    }


    bool socketHasDataNow(int socketID) {
        fd_set readSet;
        FD_ZERO(&readSet);
        FD_SET(socketID, &readSet);

        timeval timeout;
        timeout.tv_sec = 0;
        timeout.tv_usec = 0;

        int result = select(socketID + 1, &readSet, nullptr, nullptr, &timeout);
        if (result < 0) {
            std::cout << "[TCP] Failed to poll emergency socket on port " << port << ": " << std::strerror(errno) << std::endl;
        }

        return result > 0 && FD_ISSET(socketID, &readSet);
    }


    int readEmergency() {
        if (socketID < 0) {
            std::cout << "[TCP] Cannot read emergency command: backend is not connected on port " << port << "." << std::endl;
            return -1;
        }
        char buffer[1024] = {};
        ssize_t size = 10;
        int returnValue = 0;

        while (socketHasDataNow(socketID)) {
            size = read(socketID, buffer, 1024);
            if (size <= 0) {
                close(socketID);
                socketID = -1;
                std::cout << "[TCP] Backend disconnected while reading emergency command on port " << port << "." << std::endl;
                return -1;
            }

            std::string current = std::string(buffer, size);
            if (current.find(pauseCharr) != std::string::npos && !(returnValue == 5)) {
                std::cout << "[EMERGENCY] Soft stop requested by backend." << std::endl;
                returnValue = 4;
            }
            if (current.find(stopCharr) != std::string::npos) {
                std::cout << "[EMERGENCY] End command requested by backend." << std::endl;
                returnValue = 5;
            }
            if (current.find(continueCharr) != std::string::npos) {
                std::cout << "[EMERGENCY] Continue command requested by backend." << std::endl;
                returnValue = 6;
            }

        }
        return returnValue;
    }
};


struct communicator {
    uartComm myUART;
    gcodeDecoder myDec;
    tcpCommUser myTCPUser;
    tcpCommUser myEmergencyUser;
    bool homed;
    bool toContinue = false;
    fs::path gcodePathRemebered;
    size_t rememberedChar = 0;
    nanoReport remeberedReport = nanoReport(1);

    // Vyska, na kterou se stroj zvedne pri navratu z pauzy, nez se rozjede
    // v XY. Musi byt nad povrchem desky - drz to shodne se zsafe
    // v printer/millproject.
    float resumeSafeZ = 10.0f;
    bool started = false;

    communicator(fs::path port) {
        this->myUART = uartComm(port, 115200);
        myTCPUser = tcpCommUser(5000);
        myEmergencyUser = tcpCommUser(5001);
        homed = false;
    }

    void setup() {
        std::cout << "[SETUP] Starting command/report TCP server." << std::endl;
        try {
            myTCPUser.startServer();
            std::cout << "[SETUP] Command/report TCP server started successfully." << std::endl;
        } catch (...) {
            std::cout << "[SETUP] Command/report TCP server setup failed." << std::endl;
            return;
        }
        std::cout << "[SETUP] Starting emergency TCP server." << std::endl;
        try {
            myEmergencyUser.startServer();
            std::cout << "[SETUP] Emergency TCP server started successfully." << std::endl;
        } catch (...) {
            std::cout << "[SETUP] Emergency TCP server setup failed." << std::endl;
            return;
        }
        std::cout << "[SETUP] Waiting for backend emergency connection on port " << myEmergencyUser.port << "." << std::endl;
        myEmergencyUser.waitForBackend();
        std::cout << "[SETUP] Waiting for backend on port " << myTCPUser.port << "." << std::endl;
        myTCPUser.waitForBackend();
        std::cout << "[SETUP] TCP communication initialized successfully." << std::endl;

        myUART.startComm();
    }


    bool doGcodeTask(gcodeDecoder &decoder) {
        nanoReport curReport = myUART.listenUART();
        int message = myEmergencyUser.readEmergency();

        // Jedine misto, kde se vi, jak daleko jsme v souboru. Reporty z jogu
        // sem nechodi, takze tam obe pole zustanou na -1 a frontend podle
        // toho pozna, ze zadny job nebezi.
        curReport.gcodeLine = decoder.currentLine();
        curReport.gcodeLines = decoder.totalLines();
        myTCPUser.sendData(curReport);

        if (message == 4 || message == 5) {
            std::cout << "[GCODE] Stopping current G-code task because emergency command " << message << " was received." << std::endl;
            rememberedChar = 0;
            if (message == 4) {
                myUART.sendBasicCMD(basicCMD(4, {-1,-1}, -1, -1));

                // Report tohohle homingu musi nekdo precist jeste tady. Bez
                // toho by zustal ve fronte a gcodeSender by ho pri continue
                // dostal misto odpovedi na svuj ping - videl by error 7
                // s maskou koncaku, vyhodnotil by to jako "Arduino did not
                // ping back" a continue by skoncil driv, nez zacne.
                myTCPUser.sendData(myUART.listenUART());
                toContinue = true;
                remeberedReport = curReport;
            }
            return false;
        }

        basicCMD cmd = decoder.nextInstr();

        if (curReport.error != 0 && curReport.error != 4) {
            std::cout << "[UART] Arduino reported error code " << static_cast<int>(curReport.error) << "." << std::endl;
            if (curReport.error == 7 && started) {
                std::cout << "[GCODE] We were homing it ok?" << std::endl;
                started = false;
            }

            else {
                return false;
            }
        }

        if (curReport.status == 1) {
            std::cout << "[UART] Arduino did not respond, current report is from C++ comm." << std::endl;
            return false;
        }

        if (cmd.command != 254) {
            std::cout << "[GCODE] Sending command: " << static_cast<int>(cmd.command) << " with parameters X: " << cmd.position.x
                      << ", Y: " << cmd.position.y << ", Z: " << cmd.z << ", Speed: " << cmd.speed
                      << ", Spindle Speed: " << cmd.spindleSpeed << "." << std::endl;
            myUART.sendBasicCMD(cmd);

            if (cmd.command == 255 || cmd.command == 7) {
                std::cout << "[GCODE] Current G-code task finished." << std::endl;
                myTCPUser.sendData(myUART.listenUART());
                return false;
            }
        }

        if (cmd.command == 254) {
            std::cout << "[GCODE] Unsupported command encountered, skipping." << std::endl;
            myUART.sendBasicCMD(basicCMD(0, {-1,-1}, -1, -1));
        }
        return true;
    }


    void gcodeSender(fs::path gcodePath, size_t startChar = 0) {
        myUART.sendBasicCMD(basicCMD(0, {-1,-1}, -1, -1));
        nanoReport curReport = myUART.listenUART();
        myTCPUser.sendData(curReport);
        bool advance = true;
        std::ifstream file(gcodePath);
        rememberedChar = 0;

        if (!file) {
            myTCPUser.sendData(nanoReport(1, 1));
            std::cout << "[GCODE] File does not exist: " << gcodePath << std::endl;
            return;
        }

        // Ted uz je tohle opravdu odpoved na ping o radek vys, i pri continue -
        // report nouzoveho homingu se precte uz v doGcodeTask. Driv tu bylo
        // "&& !toContinue", coz pri kazdem continue poslalo rizeni do else
        // vetve a ta bezpodminecne vraci.
        if (curReport.error == 4) {
            std::cout << "[GCODE] Arduino pinged back." << std::endl;
        }

        else {
            if (curReport.status == 1) {
                std::cout << "[GCODE] Arduino didn't respond, current report is from C++ comm" << std::endl;
            }

            std::cout << "[GCODE] Arduino did not ping back, error code: " << static_cast<int>(curReport.error) << "." << std::endl;
            return;
        }
        started = false;
        if (homed) {
            myUART.sendBasicCMD(basicCMD(0, {-1,-1}, -1, -1));
        }

        else {
            myUART.sendBasicCMD(basicCMD(3));
            homed = true;
            started = true;
        }

        std::stringstream buffer;
        buffer << file.rdbuf();
        gcodeDecoder decoder = gcodeDecoder(buffer.str(), startChar);

        if (toContinue) {
            std::cout << "[GCODE] Continuing G-code task from remembered position: X " << remeberedReport.position.x
                      << ", Y " << remeberedReport.position.y << ", Z " << remeberedReport.z << "." << std::endl;

            // Navrat musi byt na tri kroky, ne jedinym prikazem. cmd 5 dela
            // moveZ a teprve pak move2D, takze jednim prikazem by stroj nejdriv
            // sjel do rezne hloubky tam, kde zrovna stoji, a v ni prejel nad
            // zapamatovane misto - pres desku. Behem pauzy se navic smi jogovat,
            // takze "kde zrovna stoji" muze byt kdekoliv.
            //
            // Kazde odeslani ma svoje cteni, aby fronta zustala na jednom
            // nepreectenem reportu, stejne jako pri normalnim startu.
            myUART.sendBasicCMD(basicCMD(5, {-1,-1}, resumeSafeZ, remeberedReport.speed, remeberedReport.spindlSpeed));
            myTCPUser.sendData(myUART.listenUART());

            myUART.sendBasicCMD(basicCMD(5, remeberedReport.position, -1, remeberedReport.speed, -1));
            myTCPUser.sendData(myUART.listenUART());

            myUART.sendBasicCMD(basicCMD(5, {-1,-1}, remeberedReport.z, remeberedReport.speed, -1));
            myTCPUser.sendData(myUART.listenUART());
            started = true;
        }

        toContinue = false;

        while (advance) {
            advance = doGcodeTask(decoder);
        }

        if (toContinue) {
            gcodePathRemebered = gcodePath;
            rememberedChar = decoder.currentChar;
        }
    }


    // Bez homingu nema stroj zadnou referenci, takze pozice v reportu je jen
    // cislo bez vyznamu a relativni pohyb muze skoncit natvrdo v konstrukci.
    // Odmitnout to uz tady usetri cely UART round-trip a hlavne se uzivatel
    // dozvi duvod, misto aby dostal zpatky jen odpoved na ping.
    void move(float x, float y, float z, float speed, float spindleSpeed) {
        if (!homed) {
            std::cout << "[TASK] Move refused, machine is not homed. Requested X=" << x
                      << " Y=" << y << " Z=" << z << " speed=" << speed
                      << " spindle=" << spindleSpeed << "." << std::endl;
            myTCPUser.sendData(nanoReport(1, 3));
            return;
        }

        myUART.sendBasicCMD(basicCMD(8, {x, y}, z, speed, spindleSpeed));
        myTCPUser.sendData(myUART.listenUART());
    }


    void operateCommunicator() {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        json newestTask = myTCPUser.readData();

        if (newestTask.is_null()) {
            std::cout << "[TASK] No valid task received from backend." << std::endl;
            return;
        }

        if (!newestTask.contains("cmd") || !newestTask["cmd"].is_number_integer()) {
            std::cout << "[TASK] Invalid task: missing numeric 'cmd' field." << std::endl;
            return;
        }

        if (!newestTask.is_null() && newestTask.contains("cmd")) {
            switch (newestTask["cmd"].get<int>()) {
                case 1: {
                    if (newestTask.contains("x") && newestTask.contains("y") && newestTask.contains("z") && newestTask.contains("speed") && newestTask.contains("spindleSpeed")) {
                        if (newestTask["x"].is_number() && newestTask["y"].is_number() && newestTask["z"].is_number() && newestTask["speed"].is_number() && newestTask["spindleSpeed"].is_number()) {
                            float x = newestTask["x"].get<float>();
                            float y = newestTask["y"].get<float>();
                            float z = newestTask["z"].get<float>();
                            float speed = newestTask["speed"].get<float>();
                            float spindleSpeed = newestTask["spindleSpeed"].get<float>();
                            if (x == -1) {
                                x = 0;
                            }
                            if (y == -1) {
                                y = 0;
                            }
                            if (z == -1) {
                                z = 0;
                            }

                            move(x, y, z, speed, spindleSpeed);
                        }
                        else {
                            std::cout << "[TASK] Invalid move task: x, y, and z must be numbers." << std::endl;
                        }
                    }
                    else {
                        std::cout << "[TASK] Invalid move task: missing x, y, or z field." << std::endl;
                    }
                    break;
                }
                case 2: {
                    myUART.sendBasicCMD(basicCMD(3));
                    homed = true;
                    myTCPUser.sendData(myUART.listenUART());
                    break;
                };
                case 3:
                    if (newestTask.contains("path") && newestTask["path"].is_string()) {
                        gcodeSender(fs::path(newestTask["path"].get<std::string>()));
                    }
                    else {
                        std::cout << "[TASK] Invalid G-code task: missing string 'path' field." << std::endl;
                    }
                    break;
                case 4: {
                    myUART.sendBasicCMD(basicCMD(4, {-1,-1}, -1, -1));
                    homed = true;
                    myTCPUser.sendData(myUART.listenUART());
                    break;
                }
                case 5: {
                    if (toContinue) {
                        std::cout << "[GCODE] Continuing G-code task from remembered position." << std::endl;
                        gcodeSender(gcodePathRemebered, rememberedChar);
                    }
                    else {
                        std::cout << "[TASK] No G-code task to continue." << std::endl;
                    }
                    break;
                }
                default:
                    std::cout << "[TASK] Unsupported task command: " << newestTask["cmd"].get<int>() << std::endl;
                    break;
            }
        }
    }
};


int main() {
    // Po kolika radcich se zaklada novy soubor. Env je hlavne kvuli testovani,
    // psat 15000 radku jen kvuli overeni rotace nema smysl.
    long logLimit = 15000;
    const char *limitFromEnv = std::getenv("CNC_LOG_MAX_LINES");

    if (limitFromEnv != nullptr && std::atol(limitFromEnv) > 0) {
        logLimit = std::atol(limitFromEnv);
    }

    // Musi byt uplne prvni, jinak by se prvni radky setupu do logu nedostaly.
    // static kvuli zivotnosti: cout na ten buffer ukazuje az do konce procesu.
    static logTee tee(std::cout.rdbuf(), resolveLogDir(), "nanoCommLog", logLimit);
    std::cout.rdbuf(&tee);
    std::cerr.rdbuf(&tee);

    std::cout << "[LOG] Console output is mirrored to " << tee.currentPath() << std::endl;

    communicator myCommunicator = communicator("/dev/arduino0");
    myCommunicator.setup();
    while (true) {
        myCommunicator.operateCommunicator();
    }
    return 0;
}
