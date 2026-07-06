#include <iostream>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json = nlohmann::json;


struct Position {
    float x, y;
};


//cmd 1 = jednoduchy move, cmd 0 = ping a otestovani, cmd 2 = nastaveni rychlosti spindl, cmd 3 = homing
struct basicCMD {
    uint8_t command;
    Position position;
    float z, speed;

    basicCMD(uint8_t cmd = 0, Position position = {0, 0}, float z = 0, float speed = 0) {
        this->command = cmd;
        this->position = position;
        this->z = z;
        this->speed = speed;
    }
};


// error 0 = ok, error 1 = neco ....
// status 0 = zprava od nana, status 1 = zprava od nanoComm
struct nanoReport {
    uint8_t status;
    uint8_t error;
    Position position;
    float z;
    float speed;

    nanoReport(uint8_t status = 0, uint8_t error = 0, Position position = {0, 0}, float z = 0, float speed = 0) {
        this->status = status;
        this->error = error;
        this->position = position;
        this->z = z;
        this->speed = speed;
    }
};


struct complexCMD {
    int cmd;
};


struct uartComm {
    fs::path port;
    bool occupied;
    int baundWith;

    uartComm(fs::path port = "", int baundWith = 115200) {
        this->port = port;
        occupied = false;
        this->baundWith = baundWith;
    }

    void sendBasicCMD(basicCMD cmd) {
        (void)cmd;
        occupied = true;
        //sending data
        occupied = false;
    }

    nanoReport listenUART() {
        if (!occupied) {
            occupied = true;
            nanoReport data = nanoReport(1, 0);
            while (true) {
                //recieving data
                if (data.status == 0) {
                    break;
                }
            }
            occupied = false;
            return data;
        }
        return nanoReport(1, 2);
    }
};


struct gcodeDecoder {
    std::string gcodeText;

    gcodeDecoder(std::string gcodeText = "") {
        this->gcodeText = gcodeText;
    }


    basicCMD nextInstr() {
        return basicCMD(255, {-1, -1}, -1, -1);
    }
};


struct filesys {
    fs::path inicilized = "../taskQueue/inicilized";
    fs::path proccesing = "../taskQueue/proccesing";
    fs::path emergency = "../taskQueue/emergency";
    fs::path answered = "../taskQueue/answered";
};


struct fileUser {
    filesys myFileSys;
    int readID = 0;
    int emergencyID = 0;
    int reportID = 0;

    json readJson() {
        fs::path curPath = myFileSys.inicilized / ("task" + std::to_string(readID) + ".json");
        std::ifstream file(curPath);

        if (file) {
            fs::path newPath = myFileSys.proccesing / curPath.filename();
            json parsed;

            try {
                parsed = json::parse(file);
            } catch (const json::parse_error&) {
                return nullptr;
            }

            fs::create_directories(myFileSys.proccesing);
            fs::rename(curPath, newPath);
            readID += 1;
            return parsed;
        }

        return nullptr;
    }

    json readEmergency() {
        fs::path curPath = myFileSys.emergency / ("emergency" + std::to_string(emergencyID) + ".json");
        std::ifstream file(curPath);

        if (file) {
            json parsed;

            try {
                parsed = json::parse(file);
            } catch (const json::parse_error&) {
                return nullptr;
            }

            emergencyID += 1;
            fs::remove(curPath);
            return parsed;
        }

        return nullptr;
    }

    void report(nanoReport report) {
        (void)report;
    }
};


struct communicator {
    uartComm myUART;
    gcodeDecoder myDec;
    fileUser myFileUser;

    communicator(const char* port) {
        this->myUART = uartComm(port);
    }


    void determineEmergency(json &emergency, basicCMD &cmd) {
        if (emergency["code"].get<int>() == 4 || emergency["code"].get<int>() == 5) {
            cmd.command = 4;
        }
    }


    bool doGcodeTask(gcodeDecoder &decoder) {
        nanoReport curReport = myUART.listenUART();
        json message = myFileUser.readEmergency();
        myFileUser.report(curReport);
        basicCMD cmd = decoder.nextInstr();

        if (curReport.error != 0) {
            return false;
        }

        if (!message.is_null()) {
            determineEmergency(message, cmd);
            myUART.sendBasicCMD(cmd);
            return false;
        }

        if (cmd.command == 255) {
            return false;
        }

        myUART.sendBasicCMD(cmd);
        return true;
    }


    void gcodeSender(fs::path gcodePath) {
        myUART.sendBasicCMD(basicCMD(0, {-1,-1}, -1, -1));
        bool advance = true;
        std::ifstream file(gcodePath);
        if (!file) {
            myFileUser.report(nanoReport(1, 1));
            return;
        }
        std::stringstream buffer;
        buffer << file.rdbuf();
        gcodeDecoder decoder = gcodeDecoder(buffer.str());
        while (advance) {
            advance = doGcodeTask(decoder);
        }
    }

    void operateCommunicator() {
        json newestTask = myFileUser.readJson();
        if (!newestTask.is_null() && newestTask.contains("cmd")) {
            switch (newestTask["cmd"].get<int>()) {

                case 3:
                    if (newestTask.contains("path") && newestTask["path"].is_string()) {
                        gcodeSender(newestTask["path"].get<fs::path>());
                    }
                    break;
            }
        }
    }
};


int main() {
    return 0;
}
